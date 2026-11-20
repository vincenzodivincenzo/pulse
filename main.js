const { app, BrowserWindow, ipcMain, Tray, nativeImage, shell, Menu, screen, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const M = require('./renderer/metrics.js');

app.setName('Pulse');

const DEBUG_DIR = process.env.PULSE_DEBUG_DIR || null;
// Test instances keep their own profile so they never touch the installed app's state.
if (DEBUG_DIR) app.setPath('userData', path.join(DEBUG_DIR, 'userdata'));

// Names that identify a chest strap, armband or watch broadcasting heart rate.
// The scan is already filtered to the standard Heart Rate service (0x180D).
const PREFERRED = /hrm|garmin|forerunner|fenix|epix|venu|instinct|enduro|vivo|polar|verity|h10|h9|wahoo|tickr|coros|suunto|whoop|scosche|rhythm|coospo|magene|moofit|xoss|igpsport|kalenji|decathlon|amazfit|zepp|myzone|cooper/i;
const FALLBACK_DELAY_MS = 2500;
const SCAN_TIMEOUT_MS = 30000;

const statePath = () => path.join(app.getPath('userData'), 'state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
  return s;
}
function log(...a) {
  if (!DEBUG_DIR) return;
  fs.appendFileSync(path.join(DEBUG_DIR, 'pulse.log'), `${new Date().toISOString()} ${a.join(' ')}\n`);
}

let win = null;
let tray = null;
const send = (ch, data) => win?.webContents.send(ch, data);

// ---------- Bluetooth device selection ----------
// Chromium asks the app to pick a device through this event. It fires again each
// time the scan finds something new, so the choice is held open until a match
// (auto mode, used at launch) or until the person picks one (manual mode).
let pending = null; // { cb, list, fallback, timeout }
let pickMode = 'auto';

function finishPick(deviceId) {
  if (!pending) return;
  clearTimeout(pending.fallback);
  clearTimeout(pending.timeout);
  const { cb, list } = pending;
  pending = null;
  if (deviceId) {
    const d = list.find((x) => x.deviceId === deviceId);
    saveState({ lastDevice: { id: deviceId, name: d?.deviceName || '' } });
    log('picked', deviceId, d?.deviceName);
  } else log('scan ended without device');
  cb(deviceId || '');
}

function choose(list) {
  const { lastDevice } = loadState();
  if (lastDevice) {
    const saved = list.find((d) => d.deviceId === lastDevice.id);
    if (saved) return saved;
  }
  return list.find((d) => PREFERRED.test(d.deviceName || '')) || null;
}

function onSelectDevice(event, list, cb) {
  event.preventDefault();
  if (!pending) {
    pending = { cb, list };
    pending.timeout = setTimeout(() => finishPick(null), SCAN_TIMEOUT_MS);
  }
  pending.cb = cb;
  pending.list = list;
  const { lastDevice } = loadState();
  send('ble:devices', list.map((d) => ({ id: d.deviceId, name: d.deviceName || 'Unnamed sensor', remembered: d.deviceId === lastDevice?.id })));
  log('devices', JSON.stringify(list.map((d) => d.deviceName)));
  if (pickMode !== 'auto') return;
  const pick = choose(list);
  if (pick) return finishPick(pick.deviceId);
  if (list.length && !pending.fallback) {
    pending.fallback = setTimeout(() => pending && pending.list.length && finishPick(pending.list[0].deviceId), FALLBACK_DELAY_MS);
  }
}
ipcMain.handle('ble:mode', (_e, mode) => { pickMode = mode === 'manual' ? 'manual' : 'auto'; return pickMode; });
ipcMain.on('ble:pick', (_e, id) => finishPick(id));
ipcMain.on('ble:cancel', () => finishPick(null));
ipcMain.on('ble:forget', () => saveState({ lastDevice: null }));

// ---------- Network input ----------
// Any app, script, phone or watch relay on the local network can send heart rate:
//   POST http://<mac>:<port>/hr  {"bpm":72,"rr":[812,830],"source":"Apple Watch"}  header X-Pulse-Token
//   GET  http://<mac>:<port>/hr?bpm=72&token=<token>
const net = { server: null, port: 8787, lastAt: 0, lastSource: '', error: '' };

function netToken() {
  let { netToken: tok } = loadState();
  if (!tok) { tok = crypto.randomBytes(4).toString('hex'); saveState({ netToken: tok }); }
  return tok;
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
function netStatus() {
  return {
    enabled: !!net.server,
    port: net.port,
    token: netToken(),
    addresses: lanAddresses(),
    lastAt: net.lastAt,
    lastSource: net.lastSource,
    error: net.error,
  };
}
function handleHr(req, res, url) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const token = req.headers['x-pulse-token'] || url.searchParams.get('token');
  if (token !== netToken()) return reply(401, { error: 'bad token' });
  const accept = (data) => {
    const bpm = Math.round(Number(data.bpm));
    if (!(bpm >= 20 && bpm <= 250)) return reply(400, { error: 'bpm must be 20-250' });
    let rr = data.rr;
    if (typeof rr === 'string') rr = rr.split(/[;, ]+/);
    rr = Array.isArray(rr) ? rr.map(Number).filter((v) => v >= 200 && v <= 3000).slice(0, 10) : [];
    const source = String(data.source || 'Network').slice(0, 40);
    net.lastAt = Date.now();
    net.lastSource = source;
    send('net:hr', { t: Date.now(), bpm, rr, source });
    reply(200, { ok: true });
  };
  if (req.method === 'GET') return accept(Object.fromEntries(url.searchParams));
  if (req.method !== 'POST') return reply(405, { error: 'use GET or POST' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    try { accept(JSON.parse(body || '{}')); } catch { reply(400, { error: 'invalid JSON' }); }
  });
}
function startNet() {
  if (net.server) return netStatus();
  net.error = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/hr') return handleHr(req, res, url);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Pulse network input. Send heart rate to /hr\n');
  });
  server.on('error', (err) => { net.error = err.message; net.server = null; send('net:status', netStatus()); });
  server.listen(net.port, '0.0.0.0');
  net.server = server;
  saveState({ netEnabled: true });
  return netStatus();
}
function stopNet() {
  net.server?.close();
  net.server = null;
  saveState({ netEnabled: false });
  return netStatus();
}
ipcMain.handle('net:status', () => netStatus());
ipcMain.handle('net:start', () => startNet());
ipcMain.handle('net:stop', () => stopNet());
ipcMain.handle('net:newToken', () => { saveState({ netToken: crypto.randomBytes(4).toString('hex') }); return netStatus(); });
ipcMain.on('copy', (_e, text) => clipboard.writeText(String(text)));

// ---------- Recording ----------
// One folder per session in ~/Documents/Pulse:
//   heart_rate.csv     one row per packet (append-only while recording)
//   markers.csv        rewritten on every marker change
//   anomalies.csv      written on stop / re-analysis
//   rr_intervals.txt   clean RR intervals in ms, one per line (Kubios compatible)
//   session.json       metadata, profile and full analysis
const OUT_DIR = () => process.env.PULSE_OUT_DIR || path.join(app.getPath('documents'), 'Pulse');
const HR_HEADER = 'timestamp,elapsed_s,bpm,rr_ms,contact,source,phase,marker\n';
const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
const slug = (s) => String(s || '').replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
let rec = null;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
function uniqueDir(root, base) {
  let dir = path.join(root, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base} (${i})`);
  return dir;
}
function phaseAt(markers, t) {
  let cur = null;
  for (const m of markers) if (m.phase && m.t <= t) cur = m;
  return cur;
}
const markLabel = (m) => (m.note ? `${m.label}: ${m.note}` : m.label);
const markType = (m) => (m.key === 'N' ? 'note' : m.phase ? 'phase' : 'event');

function hrLine(row, start, markers, prevT) {
  const phase = phaseAt(markers, row.t)?.label || '';
  const marks = markers.filter((m) => m.t > prevT && m.t <= row.t).map(markLabel).join(' | ');
  return [new Date(row.t).toISOString(), ((row.t - start) / 1000).toFixed(3), row.bpm, (row.rr || []).join(';'),
    row.contact || '', cell(row.source || ''), cell(phase), cell(marks)].join(',') + '\n';
}
function writeAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}
function writeMarkers(dir, start, markers) {
  const lines = ['timestamp,elapsed_s,key,label,type,note,bpm'];
  for (const m of markers) {
    lines.push([new Date(m.t).toISOString(), ((m.t - start) / 1000).toFixed(3), m.key, cell(m.label), markType(m), cell(m.note || ''), m.bpm ?? ''].join(','));
  }
  writeAtomic(path.join(dir, 'markers.csv'), lines.join('\n') + '\n');
}

// Write the derived files and session.json for a session folder.
function finalize(dir, meta, samples, markers, start, end) {
  const a = M.analyze(samples, markers, meta.profile || {}, start, end);
  const beats = a.beats;
  delete a.beats;

  let out = HR_HEADER;
  let prev = 0;
  for (const r of samples) { out += hrLine(r, start, markers, prev); prev = r.t; }
  writeAtomic(path.join(dir, 'heart_rate.csv'), out);
  writeMarkers(dir, start, markers);

  const an = ['start_timestamp,start_s,end_s,type,severity,title,detail'];
  for (const x of a.anomalies) an.push([new Date(x.t).toISOString(), x.at_s, x.end_s, x.type, x.severity, cell(x.title), cell(x.detail)].join(','));
  writeAtomic(path.join(dir, 'anomalies.csv'), an.join('\n') + '\n');
  writeAtomic(path.join(dir, 'rr_intervals.txt'), beats.filter((b) => !b.bad).map((b) => b.ms).join('\n') + '\n');

  const summary = {
    format: 'pulse-session',
    version: 2,
    name: meta.name,
    participant: meta.participant || '',
    protocol: meta.protocol || '',
    notes: meta.notes || '',
    device: meta.device || '',
    started_at: new Date(start).toISOString(),
    ended_at: new Date(end).toISOString(),
    duration_s: Math.round((end - start) / 1000),
    profile: meta.profile || {},
    ...a,
    markers: markers.map((m) => ({ at_s: Math.round((m.t - start) / 100) / 10, t: m.t, key: m.key, label: m.label, type: markType(m), note: m.note || '', bpm: m.bpm ?? null })),
    files: { heart_rate: 'heart_rate.csv', markers: 'markers.csv', anomalies: 'anomalies.csv', rr_intervals: 'rr_intervals.txt' },
    analyzed_at: new Date().toISOString(),
  };
  writeAtomic(path.join(dir, 'session.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

ipcMain.handle('rec:start', (_e, meta) => {
  if (rec) return { dir: rec.dir };
  const name = String(meta?.name || '').trim();
  if (!name) throw new Error('A session needs a name');
  const root = OUT_DIR();
  fs.mkdirSync(root, { recursive: true });
  const dir = uniqueDir(root, `${stamp(new Date(meta.start))} ${slug(name)}`);
  fs.mkdirSync(dir); // never reuses an existing folder
  const file = path.join(dir, 'heart_rate.csv');
  const fd = fs.openSync(file, 'wx'); // never overwrites
  fs.writeSync(fd, HR_HEADER);
  rec = { fd, file, dir, start: meta.start, meta: { ...meta, name }, rows: [], markers: [], lastT: 0 };
  writeMarkers(dir, rec.start, []);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    format: 'pulse-session', version: 2, name, participant: meta.participant || '', protocol: meta.protocol || '',
    notes: meta.notes || '', device: meta.device || '', started_at: new Date(meta.start).toISOString(), profile: meta.profile || {}, recording: true,
  }, null, 2) + '\n');
  log('rec start', dir);
  send('registry:changed');
  return { dir };
});

ipcMain.on('rec:row', (_e, row) => {
  if (!rec) return;
  fs.writeSync(rec.fd, hrLine(row, rec.start, rec.markers, rec.lastT));
  rec.rows.push(row);
  rec.lastT = row.t;
});
ipcMain.on('rec:markers', (_e, markers) => {
  if (!rec) return;
  rec.markers = [...markers].sort((a, b) => a.t - b.t);
  writeMarkers(rec.dir, rec.start, rec.markers);
});
ipcMain.on('rec:meta', (_e, patch) => { if (rec) Object.assign(rec.meta, patch); });

function stopRecording(markers) {
  if (!rec) return null;
  fs.closeSync(rec.fd);
  if (markers) rec.markers = [...markers].sort((a, b) => a.t - b.t);
  const end = Date.now();
  const { dir, rows, start, meta } = rec;
  const finalMarkers = rec.markers;
  rec = null;
  const summary = finalize(dir, meta, rows, finalMarkers, start, end);
  log('rec stop', dir, `${rows.length} rows, ${summary.markers.length} markers, ${summary.anomalies.length} anomalies`);
  send('registry:changed');
  return { dir, summary };
}
ipcMain.handle('rec:stop', (_e, opts = {}) => stopRecording(opts.markers));

// ---------- Registry ----------
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

ipcMain.handle('registry:list', () => {
  const root = OUT_DIR();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const meta = readJson(path.join(dir, 'session.json'));
    if (!meta || meta.format !== 'pulse-session') continue;
    out.push({
      dir,
      folder: name,
      name: meta.name || name,
      participant: meta.participant || '',
      protocol: meta.protocol || '',
      started_at: meta.started_at,
      duration_s: meta.duration_s ?? null,
      avg_bpm: meta.overall?.avg_bpm ?? null,
      max_bpm: meta.overall?.max_bpm ?? null,
      rmssd: meta.overall?.hrv?.rmssd_ms ?? null,
      anomalies: meta.anomalies?.length ?? 0,
      flags: meta.anomalies?.filter((a) => a.severity === 'flag').length ?? 0,
      markers: meta.markers?.length ?? 0,
      recording: !!meta.recording && rec?.dir === dir,
      incomplete: !!meta.recording && rec?.dir !== dir,
    });
  }
  return out.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
});

function loadSession(dir) {
  const meta = readJson(path.join(dir, 'session.json'));
  if (!meta) throw new Error('session.json is missing or unreadable');
  const hrFile = path.join(dir, 'heart_rate.csv');
  const rows = fs.existsSync(hrFile) ? M.csvParse(fs.readFileSync(hrFile, 'utf8')) : [];
  const samples = rows.map((r) => ({
    t: Date.parse(r.timestamp),
    bpm: Number(r.bpm),
    rr: r.rr_ms ? r.rr_ms.split(';').map(Number).filter((v) => v > 0) : [],
    contact: r.contact,
    source: r.source,
  })).filter((s) => Number.isFinite(s.t));
  const mFile = path.join(dir, 'markers.csv');
  const markers = fs.existsSync(mFile) ? M.csvParse(fs.readFileSync(mFile, 'utf8')).map((r) => ({
    t: Date.parse(r.timestamp), key: r.key, label: r.label, phase: r.type === 'phase', note: r.note, bpm: r.bpm ? Number(r.bpm) : null,
  })) : [];
  return { meta, samples, markers };
}
ipcMain.handle('session:load', (_e, dir) => loadSession(dir));

// Re-analyze from the raw files, optionally with an updated profile.
// Also repairs sessions that were cut off by a crash (no ended_at).
ipcMain.handle('session:reanalyze', (_e, dir, profile) => {
  if (rec?.dir === dir) throw new Error('This session is still recording');
  const { meta, samples, markers } = loadSession(dir);
  const start = Date.parse(meta.started_at) || samples[0]?.t;
  const end = Date.parse(meta.ended_at) || samples[samples.length - 1]?.t || start;
  const summary = finalize(dir, { ...meta, profile: profile || meta.profile }, samples, markers, start, end);
  send('registry:changed');
  return summary;
});

ipcMain.handle('session:update', (_e, dir, patch) => {
  const f = path.join(dir, 'session.json');
  const meta = readJson(f);
  if (!meta) throw new Error('session.json is missing');
  for (const k of ['name', 'participant', 'protocol', 'notes']) if (k in patch) meta[k] = String(patch[k]).trim();
  if (!meta.name) throw new Error('A session needs a name');
  writeAtomic(f, JSON.stringify(meta, null, 2) + '\n');
  let newDir = dir;
  if ('name' in patch && rec?.dir !== dir) {
    const base = `${stamp(new Date(meta.started_at))} ${slug(meta.name)}`;
    if (path.basename(dir) !== base) {
      newDir = uniqueDir(path.dirname(dir), base);
      fs.renameSync(dir, newDir);
    }
  }
  send('registry:changed');
  return { dir: newDir, meta };
});

ipcMain.handle('session:trash', async (_e, dir, name) => {
  if (rec?.dir === dir) throw new Error('Stop the recording first');
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Move “${name}” to the Trash?`,
    detail: 'The session folder and all its files go to the Trash. You can restore it from there.',
  });
  if (response !== 0) return false;
  await shell.trashItem(dir);
  send('registry:changed');
  return true;
});

ipcMain.handle('png:save', async (_e, dir, dataUrl, suggested) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export session as PNG',
    defaultPath: path.join(dir || app.getPath('documents'), suggested || 'report.png'),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  shell.showItemInFolder(filePath);
  return filePath;
});
// Test instances only: write the PNG without a dialog.
ipcMain.handle('png:saveTest', (_e, dataUrl) => {
  if (!DEBUG_DIR) return null;
  const f = path.join(DEBUG_DIR, 'report.png');
  fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return f;
});

ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('open-folder', () => { fs.mkdirSync(OUT_DIR(), { recursive: true }); shell.openPath(OUT_DIR()); });

// Watch the sessions folder so the registry stays current.
let watcher = null;
function watchRegistry() {
  try {
    fs.mkdirSync(OUT_DIR(), { recursive: true });
    let t = null;
    watcher = fs.watch(OUT_DIR(), () => { clearTimeout(t); t = setTimeout(() => send('registry:changed'), 400); });
  } catch { /* folder not watchable; manual refresh still works */ }
}

// ---------- Misc IPC ----------
ipcMain.handle('state:get', () => loadState());
ipcMain.handle('state:set', (_e, patch) => saveState(patch));
ipcMain.on('pin', (_e, on) => win?.setAlwaysOnTop(!!on, 'floating'));
ipcMain.on('tray', (_e, text) => tray?.setTitle(text, { fontType: 'monospacedDigit' }));
ipcMain.on('debug', (_e, msg) => log('renderer', msg));

// ---------- Window ----------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1280, wa.width - 40),
    height: Math.min(860, wa.height - 24),
    minWidth: 1000,
    minHeight: 660,
    title: 'Pulse',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0e1012',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('select-bluetooth-device', onSelectDevice);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), process.env.PULSE_FAKE ? { query: { fake: '1' } } : {});

  // Start scanning as soon as the app opens. requestDevice needs a user
  // gesture, so it runs with userGesture=true from here.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript('window.autoConnect && window.autoConnect()', true).catch(() => {});
  });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) log('console', e.message); });

  if (DEBUG_DIR) {
    const shots = (process.env.PULSE_SHOTS || '8,20').split(',').map(Number);
    for (const s of shots) {
      setTimeout(async () => {
        if (!win) return;
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(DEBUG_DIR, `shot_${s}s.png`), img.toPNG());
      }, s * 1000);
    }
    // PULSE_SCRIPT=file.js runs a test script in the page (test instances only).
    if (process.env.PULSE_SCRIPT) {
      const code = fs.readFileSync(process.env.PULSE_SCRIPT, 'utf8');
      win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.executeJavaScript(code, true).catch((e) => log('script error', e.message)), 1500));
    }
  }
  win.on('closed', () => { win = null; });
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('♥ --', { fontType: 'monospacedDigit' });
  tray.setToolTip('Pulse');
  tray.on('click', () => { if (win) { win.show(); win.focus(); } else createWindow(); });
}

app.whenReady().then(() => {
  createTray();
  createWindow();
  watchRegistry();
  if (loadState().netEnabled) startNet();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Open sessions folder', click: () => { fs.mkdirSync(OUT_DIR(), { recursive: true }); shell.openPath(OUT_DIR()); } }] },
  ]));
});
app.on('activate', () => { if (!win) createWindow(); else win.show(); });
app.on('before-quit', () => { if (rec) stopRecording(); watcher?.close(); net.server?.close(); });
app.on('window-all-closed', () => app.quit());
