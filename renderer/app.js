'use strict';

const $ = (id) => document.getElementById(id);
const api = window.pulse;
const M = window.PulseMetrics;
const C = window.PulseCharts;
const FAKE = new URLSearchParams(location.search).has('fake');
const STALE_MS = 5000;

// Annotation keys 1-9. phase: true labels every reading after it until the next phase marker.
const DEFAULT_KEYS = {
  1: { label: 'Baseline', phase: true },
  2: { label: 'Warm-up', phase: true },
  3: { label: 'Test', phase: true },
  4: { label: 'Recovery', phase: true },
  5: { label: 'Cool-down', phase: true },
  6: { label: 'Event', phase: false },
};
const DEFAULT_PROFILE = { age: '', sex: '', restHr: '', maxHr: '', model: 'max' };

const S = {
  state: 'idle',
  source: null,          // { kind: 'ble' | 'net' | 'demo', name }
  device: null, char: null, userDisconnect: false, retry: 0, retryTimer: null,
  battery: null, contact: null, lastPacket: 0, netIgnored: 0,
  profile: { ...DEFAULT_PROFILE }, edges: M.zoneEdges(DEFAULT_PROFILE), keys: structuredClone(DEFAULT_KEYS),
  samples: [], beats: [], markers: [], anomalies: [], live: {}, slow: {}, zt: { secs: [0, 0, 0, 0, 0, 0], trimp: 0 }, recov: [],
  slowAt: 0, anomAt: 0, sessionStart: 0,
  rec: null,             // { dir, start, name, participant, protocol }
  range: 300000, hoverT: null,
  view: 'live', registry: [], current: null, sHoverT: null,
  noteAt: 0, demoTimer: null, net: null,
  proto: null, pendingProto: null, customTpls: [], tplSel: 'resting-hrv', audio: { beeps: true, voice: true },
};

// ---------- Small helpers ----------
const clock = C.clock;
const fmt = (v, d = 0) => (v == null || !Number.isFinite(+v) ? '–' : (+v).toFixed(d));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function announce(text) {
  const el = $('announce');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = text; });
}
let toastTimer = null;
function toast(text, action, fn, ms = 5000) {
  const t = $('toast');
  t.innerHTML = '';
  t.append(document.createTextNode(text));
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.style.marginLeft = '10px';
    b.textContent = action;
    b.addEventListener('click', () => { t.hidden = true; fn(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// ---------- Source state ----------
function setState(state, title, sub) {
  S.state = state;
  document.body.dataset.state = state;
  if (title !== undefined) $('source-title').textContent = title;
  if (sub !== undefined) $('source-sub').textContent = sub;
  $('nav-live-sub').textContent = state === 'live' ? (S.rec ? `Recording · ${S.rec.name}` : S.source?.name || 'Live') : $('source-sub').textContent;
  $('rec-btn').disabled = !(S.rec || state === 'live' || state === 'stale');
  if (state !== 'live' && state !== 'stale') { api.tray('♥ --'); $('nav-bpm').textContent = '--'; }
  renderRecbar();
  api.debug(`state ${state} ${title ?? ''} ${sub ?? ''}`);
}
function finder(title, body) {
  $('finder-title').textContent = title;
  $('finder-body').textContent = body;
}
function sourceSub() {
  const parts = [];
  if (S.source?.kind === 'ble') parts.push('Bluetooth');
  if (S.source?.kind === 'net') parts.push('Network input');
  if (S.source?.kind === 'demo') parts.push('Simulated');
  if (S.battery != null) parts.push(`${S.battery}% battery`);
  if (S.live.rr_available === false && S.samples.length > 5) parts.push('no RR intervals');
  return parts.join(' · ');
}

function stopSource() {
  clearTimeout(S.retryTimer);
  clearInterval(S.demoTimer);
  S.demoTimer = null;
  if (S.device?.gatt?.connected) { S.userDisconnect = true; S.device.gatt.disconnect(); }
  S.device = null;
  S.char = null;
  S.source = null;
  S.battery = null;
}

// ---------- Bluetooth ----------
async function scan(manual = false) {
  stopSource();
  $('device-list').innerHTML = '';
  $('dlg-device-list').innerHTML = '';
  setState('scanning', 'Searching…', manual ? 'Pick a sensor from the list' : 'Looking for heart rate sensors');
  finder('Looking for sensors…', 'Put the strap on (wet electrodes help) or turn on heart rate broadcast on your watch.');
  try {
    await api.setScanMode(manual ? 'manual' : 'auto');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service', 'device_information'],
    });
    S.device = device;
    S.source = { kind: 'ble', name: device.name || 'Heart rate sensor' };
    if (!device.__pulse) {
      device.__pulse = true;
      device.addEventListener('gattserverdisconnected', () => onDisconnected(device));
    }
    S.userDisconnect = false;
    S.retry = 0;
    await connect();
  } catch (err) {
    handleScanError(err);
  }
}

function handleScanError(err) {
  const msg = String(err?.message || err);
  api.debug('scan error ' + err?.name + ' ' + msg);
  if (S.source && S.source.kind !== 'ble') return; // another source took over while scanning
  if (/adapter not available|bluetooth.*off|powered/i.test(msg)) {
    setState('error', 'Bluetooth is off', 'Turn it on in Control Center');
    finder('Bluetooth is off', 'Turn Bluetooth on from Control Center, then scan again. Network input and demo data still work.');
  } else if (/permission|denied|not allowed/i.test(msg) && err?.name !== 'NotFoundError') {
    setState('error', 'No Bluetooth access', 'Allow Pulse in System Settings');
    finder('Pulse needs Bluetooth access', 'Open System Settings › Privacy & Security › Bluetooth and turn on Pulse, then scan again.');
  } else {
    setState('notfound', 'No sensor found', 'Scan again or pick another source');
    finder('No heart rate sensor found', 'Wear the strap or start heart rate broadcast on your watch, then scan again. A watch or app already connected to the sensor can use up its Bluetooth slots.');
  }
}

function renderDeviceLists(list) {
  for (const ul of [$('device-list'), $('dlg-device-list')]) {
    ul.innerHTML = '';
    for (const d of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span class="name"></span><span class="tag"></span>';
      b.querySelector('.name').textContent = d.name;
      b.querySelector('.tag').textContent = d.remembered ? 'Last used · Connect' : 'Connect';
      b.addEventListener('click', () => api.pick(d.id));
      li.appendChild(b);
      ul.appendChild(li);
    }
  }
}
api.onDevices((list) => {
  renderDeviceLists(list);
  if (list.length && S.state === 'scanning') $('source-sub').textContent = `${list.length} found`;
});

async function connect() {
  const device = S.device;
  if (!device) return;
  setState('connecting', S.source.name, 'Connecting…');
  try {
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService('heart_rate');
    const ch = await svc.getCharacteristic('heart_rate_measurement');
    if (S.char !== ch) {
      ch.addEventListener('characteristicvaluechanged', (e) => onBleValue(e.target.value));
      S.char = ch;
    }
    await ch.startNotifications();
    S.retry = 0;
    if (!S.sessionStart) S.sessionStart = Date.now();
    S.lastPacket = 0;
    setState('live', S.source.name, 'Connected · waiting for data');
    readBattery(server);
  } catch (err) {
    api.debug('connect error ' + (err?.message || err));
    scheduleReconnect();
  }
}
async function readBattery(server) {
  try {
    const ch = await (await server.getPrimaryService('battery_service')).getCharacteristic('battery_level');
    S.battery = (await ch.readValue()).getUint8(0);
    try {
      ch.addEventListener('characteristicvaluechanged', (e) => { S.battery = e.target.value.getUint8(0); });
      await ch.startNotifications();
    } catch { /* optional */ }
  } catch { S.battery = null; }
}
function onDisconnected(device) {
  if (device !== S.device) return;
  api.debug('gatt disconnected');
  if (S.userDisconnect) {
    setState('idle', S.source?.name || 'No source', 'Disconnected');
    finder('Disconnected', 'Pick a source to continue.');
    return;
  }
  scheduleReconnect();
}
function scheduleReconnect() {
  if (!S.device || S.userDisconnect) return;
  const delay = Math.min(1000 * 2 ** S.retry, 10000);
  S.retry++;
  setState('reconnecting', S.source?.name, `Signal lost · retrying in ${Math.round(delay / 1000)} s`);
  clearTimeout(S.retryTimer);
  S.retryTimer = setTimeout(connect, delay);
}

// Heart Rate Measurement characteristic (0x2A37)
function onBleValue(dv) {
  const flags = dv.getUint8(0);
  let i = 1;
  let bpm;
  if (flags & 0x01) { bpm = dv.getUint16(i, true); i += 2; } else { bpm = dv.getUint8(i); i += 1; }
  const cb = (flags >> 1) & 0x03;
  if (flags & 0x08) i += 2;
  const rr = [];
  if (flags & 0x10) for (; i + 1 < dv.byteLength; i += 2) rr.push(Math.round((dv.getUint16(i, true) / 1024) * 1000));
  ingest({ t: Date.now(), bpm, rr, contact: cb === 3 ? 'yes' : cb === 2 ? 'no' : 'n/a', source: S.source?.name || 'Bluetooth' });
}

// ---------- Network input ----------
api.onNetHr((m) => {
  if (S.source?.kind === 'ble' && (S.state === 'live' || S.state === 'connecting')) { S.netIgnored++; return; }
  if (S.source?.kind === 'demo') stopSource();
  if (S.source?.kind !== 'net' || S.source.name !== m.source) {
    S.source = { kind: 'net', name: m.source };
    if (!S.sessionStart) S.sessionStart = Date.now();
  }
  ingest({ t: m.t, bpm: m.bpm, rr: m.rr, contact: 'n/a', source: m.source });
  renderNet();
});
api.onNetStatus((st) => { S.net = st; renderNet(); });

// ---------- Demo source ----------
function startDemo() {
  stopSource();
  S.source = { kind: 'demo', name: 'Demo strap' };
  S.sessionStart = S.sessionStart || Date.now();
  setState('live', 'Demo strap', 'Simulated');
  const t0 = Date.now();
  let beatT = t0;
  let pendingLong = false;
  const target = (s) => {
    const p = s % 420;
    if (p < 60) return 64;
    if (p < 200) return 64 + ((p - 60) / 140) * 96;
    if (p < 250) return 160;
    if (p < 330) return 160 - ((p - 250) / 80) * 65;
    return 95 - ((p - 330) / 90) * 28;
  };
  let hr = 64;
  S.demoTimer = setInterval(() => {
    const now = Date.now();
    const rr = [];
    while (beatT < now) {
      const s = (beatT - t0) / 1000;
      hr += (target(s) - hr) * 0.08;
      let ms = (60000 / hr) * (1 + (hr < 110 ? 0.045 : 0.012) * Math.sin(2 * Math.PI * 0.24 * s)) + (Math.random() - 0.5) * 14;
      if (pendingLong) { ms *= 1.32; pendingLong = false; } else if (Math.random() < 0.006) { ms *= 0.68; pendingLong = true; }
      beatT += ms;
      rr.push(Math.round(ms));
    }
    ingest({ t: now, bpm: Math.round(hr), rr, contact: 'yes', source: 'Demo strap' });
  }, 1000);
}

// ---------- Ingest + compute ----------
function ingest(m) {
  S.samples.push(m);
  S.lastPacket = m.t;
  S.contact = m.contact;
  if (!S.sessionStart) S.sessionStart = m.t;
  if (S.rec) api.recRow(m);
  compute();
  if (S.state !== 'live') setState('live', S.source?.name || m.source, sourceSub());
  else $('source-sub').textContent = sourceSub();
  if (S.view === 'live') renderLive();
  $('nav-bpm').textContent = m.bpm;
  api.tray(`♥ ${m.bpm}`);
}

function compute(force = false) {
  const now = Date.now();
  S.beats = M.markArtifacts(M.beatsFrom(S.samples));
  S.live = M.live(S.samples, S.beats, S.profile, now);
  if (force || now - S.slowAt > 5000) { S.slow = M.liveSlow(S.beats, now); S.slowAt = now; }
  if (force || now - S.anomAt > 2000) {
    const prev = S.anomalies.length;
    S.anomalies = M.anomalies(S.samples, S.beats, S.markers, S.profile, now);
    S.anomAt = now;
    if (S.anomalies.length > prev) { const a = S.anomalies[S.anomalies.length - 1]; announce(`Check: ${a.title}`); }
  }
  S.zt = M.zoneTime(S.samples, S.edges);
  S.recov = M.recoveries(S.samples, S.markers, now);
}

function resetLive() {
  if (S.rec) return;
  const backup = { samples: S.samples, markers: S.markers, sessionStart: S.sessionStart };
  S.samples = []; S.markers = []; S.beats = []; S.anomalies = []; S.recov = [];
  S.sessionStart = S.source ? Date.now() : 0;
  compute(true);
  renderMarkers();
  renderLive();
  toast('Live session cleared.', 'Undo', () => {
    S.samples = backup.samples; S.markers = backup.markers; S.sessionStart = backup.sessionStart;
    compute(true); renderMarkers(); renderLive();
  }, 7000);
}

// ---------- Live rendering ----------
const TILES = [
  { id: 'hr30', label: 'HR 30 s', unit: 'bpm', needsRR: false,
    value: () => S.live.hr30, sub: () => `10 s avg ${fmt(S.live.hr10)}`,
    info: ['Smoothed heart rate', 'Average of all readings in the last 30 seconds (10 seconds below). Use it to read steady states without beat-to-beat noise.'] },
  { id: 'rmssd', label: 'RMSSD', unit: 'ms', needsRR: true,
    value: () => S.live.rmssd, sub: () => '60 s window',
    info: ['RMSSD', 'Root mean square of successive RR differences over the last 60 s. Tracks vagal (parasympathetic) activity: higher at rest usually means more recovered.', 'Compare within the same person and conditions, not between people. Drops sharply with exercise intensity.'] },
  { id: 'sdnn', label: 'SDNN', unit: 'ms', needsRR: true,
    value: () => S.live.sdnn, sub: () => '2 min window',
    info: ['SDNN', 'Standard deviation of clean RR intervals over the last 2 minutes. Reflects overall variability (sympathetic and parasympathetic). Depends strongly on window length, so compare same-length windows only.'] },
  { id: 'pnn50', label: 'pNN50', unit: '%', needsRR: true,
    value: () => S.live.pnn50, sub: () => '2 min window',
    info: ['pNN50', 'Share of successive RR differences larger than 50 ms over the last 2 minutes. Another vagal marker, closely related to RMSSD. Often near 0% during exercise.'] },
  { id: 'dfa', label: 'DFA α1', unit: '', needsRR: true, digits: 2, slow: true,
    value: () => S.slow.dfa_a1, sub: () => (S.slow.dfa_a1 == null ? '' : S.slow.dfa_reliable ? M.dfaLabel(S.slow.dfa_a1) : 'artifacts > 5%, unreliable'),
    pending: () => collecting(120000),
    info: ['DFA α1', 'Short-term fractal correlation of RR intervals (box sizes 4–16 beats, last 2 min). About 1.0 at easy effort, around 0.75 near the aerobic threshold and around 0.5 near the anaerobic threshold (Rogers et al., 2021).', 'Needs clean RR from a chest strap. Ignore it when artifacts exceed 5%.'] },
  { id: 'lfhf', label: 'LF/HF', unit: '', needsRR: true, digits: 2, slow: true,
    value: () => S.slow.spectral?.lf_hf, sub: () => (S.slow.spectral ? `LF ${fmt(S.slow.spectral.lf_nu)} · HF ${fmt(S.slow.spectral.hf_nu)} nu` : ''),
    pending: () => collecting(110000),
    info: ['LF/HF ratio', 'Power of slow (0.04–0.15 Hz) versus fast (0.15–0.4 Hz) RR oscillations over the last 5 min, computed with a Lomb-Scargle periodogram.', 'Only meaningful at rest and in stable conditions (2–5 min). Interpret with care: it is not a clean index of sympathetic balance.'] },
  { id: 'resp', label: 'Breathing', unit: '/min', needsRR: true, digits: 1, slow: true,
    value: () => S.slow.spectral?.resp_rate_bpm, sub: () => 'estimate from RSA',
    pending: () => collecting(110000),
    info: ['Breathing rate (estimate)', 'The dominant RR oscillation between 0.1 and 0.5 Hz, from respiratory sinus arrhythmia. Works best at rest with relaxed breathing; unreliable during hard exercise.'] },
  { id: 'trimp', label: 'TRIMP', unit: '', needsRR: false, digits: 1,
    value: () => S.zt.trimp, sub: () => `${clock(S.zt.secs.reduce((a, b) => a + b, 0) * 1000)} in zones`,
    info: ['Training load (Edwards TRIMP)', 'Minutes spent in each zone multiplied by the zone number (1–5), summed. A simple, zone-based measure of session load.'] },
  { id: 'hrr', label: 'HR recovery', unit: 'bpm', needsRR: false, digits: 0,
    value: () => { const r = S.recov[S.recov.length - 1]; return r ? (r.hrr60_bpm ?? null) : null; },
    sub: () => { const r = S.recov[S.recov.length - 1]; return r ? (r.hrr60_bpm != null ? `peak ${r.peak_bpm} → ${fmt(r.hr60_bpm)} at 60 s` : '') : ''; },
    pending: () => { const r = S.recov[S.recov.length - 1]; if (!r) return 'Mark Recovery (key 4)'; const left = Math.max(0, 60000 - (Date.now() - r.t)); return left ? `Measuring · ${Math.ceil(left / 1000)} s` : null; },
    info: ['Heart rate recovery (HRR60)', 'Peak heart rate in the 30 s before a Recovery or Cool-down phase marker minus heart rate 60 s later (120 s value is saved too). Higher means faster recovery; under 12 bpm at 1 minute is commonly flagged in clinical exercise testing.'] },
  { id: 'quality', label: 'Signal quality', unit: '%', needsRR: true, digits: 1,
    value: () => S.live.artifact_pct, sub: () => 'artifacts, last 60 s',
    info: ['Signal quality', 'Share of RR intervals flagged in the last 60 s: outside 300–2000 ms or more than 20% away from the local median (ectopic beats, missed beats or poor contact). Keep under 5% for HRV metrics.'] },
];
function collecting(need) {
  if (!S.beats.length) return null;
  const have = Date.now() - S.beats[0].t;
  return have < need ? `Collecting ${clock(have)} of ${clock(need)}` : null;
}

function buildTiles() {
  const wrap = $('tiles');
  wrap.innerHTML = '';
  for (const t of TILES) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.id = `tile-${t.id}`;
    el.innerHTML = `<div class="tile-top"><span class="tile-label">${esc(t.label)}</span><button class="info" type="button" aria-label="About ${esc(t.label)}" popovertarget="pop-${t.id}">i</button></div><span class="tile-value">–</span><span class="tile-sub"></span>`;
    wrap.appendChild(el);
    const pop = document.createElement('div');
    pop.id = `pop-${t.id}`;
    pop.className = 'pop';
    pop.setAttribute('popover', '');
    pop.innerHTML = `<h3>${esc(t.info[0])}</h3>${t.info.slice(1).map((p) => `<p>${esc(p)}</p>`).join('')}`;
    pop.addEventListener('toggle', (e) => {
      if (e.newState !== 'open') return;
      const r = el.getBoundingClientRect();
      const w = 300;
      pop.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - w - 12)}px`;
      pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 12)}px`;
    });
    document.body.appendChild(pop);
  }
}

function renderTiles() {
  if (!$('tiles').children.length) return;
  const live = S.state === 'live' || S.state === 'stale';
  const noRR = S.samples.length > 5 && !S.live.rr_available;
  for (const t of TILES) {
    const el = $(`tile-${t.id}`);
    const v = el.querySelector('.tile-value');
    const sub = el.querySelector('.tile-sub');
    let pending = null;
    if (!S.samples.length) pending = '–';
    else if (t.needsRR && noRR) pending = 'Needs RR';
    else if (t.pending) pending = t.pending();
    const val = t.value();
    if (pending && (val == null || t.id === 'hrr')) {
      el.classList.add('pending');
      v.textContent = pending;
      sub.textContent = t.needsRR && noRR ? 'Source sends BPM only' : t.sub ? (t.sub() || '') : '';
    } else {
      el.classList.remove('pending');
      v.innerHTML = val == null ? '–' : `${fmt(val, t.digits ?? 0)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}`;
      sub.textContent = t.sub ? t.sub() : '';
    }
    el.style.opacity = live || !S.samples.length ? '' : '0.6';
  }
}

function renderHero() {
  const live = S.state === 'live' && S.live.bpm != null;
  $('bpm').textContent = S.live.bpm != null && (S.state === 'live' || S.state === 'stale') ? S.live.bpm : '--';
  const chip = $('zone-chip');
  const bars = $('zonebar').children;
  if (live) {
    const z = M.zoneOf(S.live.bpm, S.edges);
    chip.dataset.z = z;
    chip.textContent = 'Z' + z;
    $('zone-name').textContent = M.ZONES[z].name;
    $('zone-pct').textContent = `${S.live.pct_max}% max${S.live.pct_hrr != null ? ` · ${S.live.pct_hrr}% HRR` : ''}`;
    for (let i = 0; i < 5; i++) bars[i].classList.toggle('on', i === z - 1);
    const e = S.edges;
    const lo = z === 0 ? e[0] - 30 : e[z - 1];
    const hi = z === 0 ? e[0] : z === 5 ? e[5] : e[z];
    const seg = ($('zonebar').clientWidth - 12) / 5;
    const zi = Math.max(1, z);
    const frac = z === 0 ? 0 : Math.min(1, Math.max(0, (S.live.bpm - lo) / Math.max(1, hi - lo)));
    $('marker').style.transform = `translateX(${(zi - 1) * (seg + 3) + frac * seg}px)`;
  } else {
    delete chip.dataset.z;
    chip.textContent = '–';
    $('zone-name').textContent = S.state === 'stale' ? 'No fresh data' : 'No signal';
    $('zone-pct').textContent = '';
    for (const b of bars) b.classList.remove('on');
  }
  const warn = $('warn');
  warn.hidden = !(live && S.contact === 'no');
  if (!warn.hidden) warn.textContent = 'No skin contact. Wet the electrodes and tighten the strap.';
}

function renderZoneScale() {
  const e = S.edges;
  $('zone-scale').innerHTML = [1, 2, 3, 4, 5].map((z) => `<span>Z${z} ${e[z - 1]}+</span>`).join('');
}

function renderChart() {
  const cv = $('chart');
  const { ctx, w, h } = sizeCanvas(cv);
  const now = Date.now();
  const t0 = S.range === 'all' ? (S.sessionStart || now - 60000) : now - S.range;
  const th = C.themeFromCSS();
  S.chartLayout = C.draw(ctx, { x: 0, y: 0, w, h }, {
    samples: S.samples, beats: S.beats, markers: S.markers, anomalies: S.anomalies, edges: S.edges,
    t0, t1: now, xMode: S.range === 'all' ? 'elapsed' : 'ago', origin: S.sessionStart, hoverT: S.hoverT,
    emptyText: S.source ? 'Waiting for data…' : 'Connect a source to see heart rate',
    rrHint: S.samples.length ? 'This source sends BPM only (no RR intervals)' : 'RR intervals appear here',
  }, th);
}

function renderAnoms(listEl, countEl, anoms, origin, onPick) {
  listEl.innerHTML = '';
  const flags = anoms.filter((a) => a.severity === 'flag').length;
  countEl.textContent = anoms.length;
  countEl.className = 'count-pill' + (flags ? ' flag' : anoms.length ? ' has' : '');
  for (const a of [...anoms].reverse().slice(0, 100)) {
    const li = document.createElement('li');
    const row = document.createElement(onPick ? 'button' : 'div');
    if (onPick) { row.type = 'button'; row.className = 'a-row'; row.addEventListener('click', () => onPick(a)); }
    else row.className = 'a-row';
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.innerHTML = `<span class="m-time"></span><span class="sev ${a.severity === 'flag' ? 'flag' : ''}" aria-hidden="true"></span><span class="a-body"><span class="a-title"></span><span class="a-detail"></span></span>`;
    row.querySelector('.m-time').textContent = clock(a.t - origin);
    row.querySelector('.a-title').innerHTML = `${esc(a.title)}<span class="sev-text">${a.severity === 'flag' ? 'physiological flag' : 'data quality'}</span>`;
    row.querySelector('.a-detail').textContent = a.detail;
    li.appendChild(row);
    listEl.appendChild(li);
  }
}

function renderRecbar() {
  const btn = $('rec-btn');
  if (S.rec) {
    btn.classList.add('on', 'recording');
    $('rec-label').textContent = `Stop · ${clock(Date.now() - S.rec.start)}`;
    $('rec-name').textContent = S.rec.name;
    $('rec-sub').textContent = [S.rec.participant, S.rec.protocol, 'saving to the registry'].filter(Boolean).join(' · ');
  } else {
    btn.classList.remove('on', 'recording');
    $('rec-label').textContent = 'Record…';
    $('rec-name').textContent = 'Not recording';
    $('rec-sub').textContent = S.state === 'live' || S.state === 'stale' ? 'Press Record to name and save a session.' : 'Connect a source to record a named session.';
  }
  const bar = $('zt-bar');
  const { ctx, w, h } = sizeCanvas(bar);
  C.zoneBar(ctx, { x: 0, y: 0, w, h }, S.zt.secs, C.themeFromCSS());
  const tot = S.zt.secs.reduce((a, b) => a + b, 0);
  $('zt-text').textContent = tot ? S.zt.secs.map((s, z) => (s ? `Z${z} ${Math.round((100 * s) / tot)}%` : null)).filter(Boolean).slice(-3).join(' · ') : '–';
}

function renderLive() {
  renderHero();
  renderTiles();
  renderChart();
  renderAnoms($('anoms'), $('anom-count'), S.anomalies, S.sessionStart || Date.now());
  $('anom-empty').hidden = S.anomalies.length > 0;
  renderPhase();
  renderRecbar();
  $('session-time').textContent = S.sessionStart ? `live session ${clock(Date.now() - S.sessionStart)}` : '';
  $('reset-btn').disabled = !!S.rec || !S.samples.length;
}

// ---------- Markers ----------
const markerBase = () => (S.rec ? S.rec.start : S.sessionStart || S.markers[0]?.t || Date.now());
function currentPhase(now = Date.now()) {
  let cur = null;
  for (const m of S.markers) if (m.phase && m.t <= now) cur = m;
  return cur;
}
function flashKey(key) {
  const el = document.querySelector(`.key[data-key="${key}"]`);
  if (!el) return;
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 180);
}
function addMarker(key, note = '', t = Date.now()) {
  const def = key === 'N' ? { label: 'Note', phase: false } : S.keys[key];
  if (!def || !def.label) return;
  return pushMarker({ key: String(key), label: def.label, phase: !!def.phase, note, t });
}
function pushMarker({ key, label, phase, note = '', t = Date.now() }) {
  const m = { id: crypto.randomUUID(), t, key, label, phase: !!phase, note, bpm: S.state === 'live' ? S.live.bpm : null };
  S.markers.push(m);
  S.markers.sort((a, b) => a.t - b.t);
  if (S.rec) api.recMarkers(S.markers);
  flashKey(key);
  announce(`${m.label} marked at ${clock(t - markerBase())}`);
  compute(true);
  renderMarkers();
  if (S.view === 'live') renderLive();
}
function removeMarker(id) {
  S.markers = S.markers.filter((m) => m.id !== id);
  if (S.rec) api.recMarkers(S.markers);
  compute(true);
  renderMarkers();
  renderLive();
}
function renderKeys() {
  const wrap = $('keys');
  wrap.innerHTML = '';
  const cur = currentPhase();
  const add = (key, def) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key' + (def.phase ? '' : ' instant') + (cur && cur.key === String(key) ? ' current' : '');
    b.dataset.key = key;
    b.innerHTML = '<kbd></kbd><span class="label"></span>';
    b.querySelector('kbd').textContent = key;
    b.querySelector('.label').textContent = def.label;
    b.title = def.phase ? `Start phase “${def.label}”` : `Mark “${def.label}”`;
    b.addEventListener('click', () => (key === 'N' ? openNote() : addMarker(key)));
    wrap.appendChild(b);
  };
  for (let k = 1; k <= 9; k++) if (S.keys[k]?.label) add(k, S.keys[k]);
  add('N', { label: 'Note…', phase: false });
}
function renderMarkers() {
  const ol = $('markers');
  ol.innerHTML = '';
  const base = markerBase();
  for (const m of [...S.markers].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="m-time"></span><kbd></kbd><span class="m-label"></span><span class="m-note"></span><span class="m-bpm"></span><button class="m-del" type="button">×</button>';
    li.querySelector('.m-time').textContent = clock(m.t - base);
    li.querySelector('kbd').textContent = m.key;
    li.querySelector('.m-label').textContent = m.label;
    li.querySelector('.m-note').textContent = m.note;
    li.querySelector('.m-note').title = m.note;
    li.querySelector('.m-bpm').textContent = m.bpm ? `${m.bpm} bpm` : '';
    const del = li.querySelector('.m-del');
    del.setAttribute('aria-label', `Remove ${m.label} at ${clock(m.t - base)}`);
    del.addEventListener('click', () => removeMarker(m.id));
    ol.appendChild(li);
  }
  renderPhase();
  renderKeys();
  $('session-title').textContent = S.rec ? `Markers · ${S.rec.name}` : 'Markers';
  $('session-hint').textContent = S.rec
    ? 'Recording · markers are saved with this session. Press 1–9 for a phase, N for a note.'
    : 'Not recording · markers show on the chart only. Press 1–9 for a phase, N for a note.';
}
function renderPhase() {
  const pill = $('phase-pill');
  const cur = currentPhase();
  pill.hidden = !cur;
  if (cur) pill.textContent = `${cur.label} · ${clock(Date.now() - cur.t)}`;
}
// The note's timestamp is taken when N is pressed, not when it is saved.
function openNote() {
  S.noteAt = Date.now();
  $('note-time').textContent = clock(S.noteAt - markerBase());
  $('note-row').hidden = false;
  $('note-input').value = '';
  $('note-input').focus();
}
function closeNote() { $('note-row').hidden = true; $('note-input').blur(); }
$('note-row').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('note-input').value.trim();
  if (text) addMarker('N', text, S.noteAt);
  closeNote();
});
$('note-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeNote(); } });
$('note-input').addEventListener('blur', () => { if (!$('note-input').value.trim()) $('note-row').hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (S.proto && (e.key === ' ' || e.key === 'ArrowRight')) { e.preventDefault(); protoNext(); return; }
  if (/^[1-9]$/.test(e.key)) { e.preventDefault(); addMarker(e.key); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); if (S.view !== 'live') showLive(); openNote(); }
});

// ---------- Profile form (shared by Record and Profile dialogs, and session details) ----------
function buildProfileFields(container, profile, onChange) {
  container.innerHTML = `
    <label>Age<input name="age" type="number" inputmode="numeric" min="5" max="110" placeholder="years"></label>
    <label>Sex<select name="sex"><option value="">Not set</option><option value="female">Female</option><option value="male">Male</option></select></label>
    <label>Resting HR<input name="restHr" type="number" inputmode="numeric" min="25" max="130" placeholder="bpm"></label>
    <label>Max HR<input name="maxHr" type="number" inputmode="numeric" min="100" max="240" placeholder="auto"></label>
    <label class="wide">Zone model<select name="model"><option value="max">% of max HR (standard)</option><option value="hrr">% of HR reserve (Karvonen, needs resting HR)</option></select></label>
    <span class="field-error wide" data-profile-error hidden></span>`;
  for (const k of ['age', 'sex', 'restHr', 'maxHr', 'model']) container.querySelector(`[name="${k}"]`).value = profile[k] ?? '';
  container.addEventListener('input', () => onChange?.(readProfile(container)));
}
function readProfile(container) {
  const g = (k) => container.querySelector(`[name="${k}"]`).value.trim();
  return { age: g('age'), sex: g('sex'), restHr: g('restHr'), maxHr: g('maxHr'), model: g('model') || 'max' };
}
function profileError(p) {
  const n = (v) => (v === '' ? null : Number(v));
  if (p.age !== '' && !(n(p.age) >= 5 && n(p.age) <= 110)) return 'Age must be between 5 and 110.';
  if (p.restHr !== '' && !(n(p.restHr) >= 25 && n(p.restHr) <= 130)) return 'Resting HR must be between 25 and 130 bpm.';
  if (p.maxHr !== '' && !(n(p.maxHr) >= 100 && n(p.maxHr) <= 240)) return 'Max HR must be between 100 and 240 bpm.';
  if (p.restHr !== '' && n(p.restHr) >= M.maxHr(p) - 20) return 'Resting HR must be well below max HR.';
  if (p.model === 'hrr' && p.restHr === '') return 'The Karvonen model needs a resting HR.';
  return null;
}
function zonesPreview(p) {
  const e = M.zoneEdges(p);
  return `Max ${e[5]} bpm (${M.maxHrSource(p)}) · Z1 ${e[0]} · Z2 ${e[1]} · Z3 ${e[2]} · Z4 ${e[3]} · Z5 ${e[4]}+`;
}
function wireProfileForm(form, profile) {
  const box = form.querySelector('[data-profile]');
  const prev = form.querySelector('[data-zones-preview]');
  const update = (p) => {
    prev.textContent = zonesPreview(p);
    box.querySelector('[name="maxHr"]').placeholder = `auto ${M.maxHr({ ...p, maxHr: '' })}`;
  };
  buildProfileFields(box, profile, update);
  update(profile);
}
function applyProfile(p) {
  S.profile = p;
  S.edges = M.zoneEdges(p);
  api.setState({ profile: p });
  renderZoneScale();
  compute(true);
  renderLive();
}

// ---------- Dialogs ----------
const recDlg = $('rec-dialog');
const recForm = $('rec-form');
async function openRecDialog(opts = {}) {
  const st = await api.getState();
  recForm.elements.name.value = '';
  recForm.elements.participant.value = st.lastParticipant || '';
  recForm.elements.protocol.value = opts.protocol ?? st.lastProtocol ?? '';
  recForm.elements.notes.value = '';
  $('rec-name-error').hidden = true;
  wireProfileForm(recForm, S.profile);
  recForm.querySelector('[data-profile-error]').hidden = true;
  recDlg.showModal();
  recForm.elements.name.focus();
}
recForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'start') return;
  e.preventDefault();
  const name = recForm.elements.name.value.trim();
  const profile = readProfile(recForm.querySelector('[data-profile]'));
  const perr = profileError(profile);
  $('rec-name-error').hidden = !!name;
  $('rec-name-error').textContent = 'Give the session a name so you can find it in the registry.';
  const pe = recForm.querySelector('[data-profile-error]');
  pe.hidden = !perr;
  pe.textContent = perr || '';
  if (!name) { recForm.elements.name.focus(); return; }
  if (perr) { recForm.querySelector('[data-profile] input').focus(); return; }
  const meta = {
    name,
    participant: recForm.elements.participant.value.trim(),
    protocol: recForm.elements.protocol.value.trim(),
    notes: recForm.elements.notes.value.trim(),
    profile,
    device: S.source?.name || '',
    start: Date.now(),
    protocol_plan: S.pendingProto ? protocolPlan(S.pendingProto) : null,
  };
  applyProfile(profile);
  api.setState({ lastParticipant: meta.participant, lastProtocol: meta.protocol });
  try {
    const res = await api.recStart(meta);
    S.rec = { ...meta, dir: res.dir };
    S.markers = [];
    recDlg.close();
    compute(true);
    renderMarkers();
    renderLive();
    setState(S.state);
    loadRegistry();
    announce(`Recording ${name}`);
    if (S.pendingProto) { const t = S.pendingProto; S.pendingProto = null; startProtocol(t); }
  } catch (err) {
    toast(`Could not start recording: ${err.message}`);
  }
});

async function stopRecording() {
  if (S.proto) endProtocol({ silent: true });
  const res = await api.recStop({ markers: S.markers });
  const name = S.rec?.name;
  S.rec = null;
  renderMarkers();
  setState(S.state);
  renderLive();
  await loadRegistry();
  if (res) toast(`Saved “${name}”.`, 'Open', () => openSession(res.dir), 8000);
}
$('rec-btn').addEventListener('click', () => (S.rec ? stopRecording() : openRecDialog()));
recDlg.addEventListener('close', () => { if (!S.rec) S.pendingProto = null; });

const profDlg = $('profile-dialog');
const profForm = $('profile-form');
$('profile-btn').addEventListener('click', () => {
  wireProfileForm(profForm, S.profile);
  profForm.querySelector('[data-profile-error]').hidden = true;
  profDlg.showModal();
  profForm.querySelector('[name="age"]').focus();
});
profForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const p = readProfile(profForm.querySelector('[data-profile]'));
  const err = profileError(p);
  if (err) {
    e.preventDefault();
    const pe = profForm.querySelector('[data-profile-error]');
    pe.hidden = false;
    pe.textContent = err;
    return;
  }
  applyProfile(p);
  if (S.rec) toast('Zones updated for the live view. The recording keeps the profile it started with; re-analyze it later to apply changes.');
});

// Sources dialog
const devDlg = $('devices-dialog');
async function openDevices() {
  S.net = await api.netStatus();
  renderNet();
  devDlg.showModal();
}
$('devices-btn').addEventListener('click', openDevices);
$('source-chip').addEventListener('click', openDevices);
$('finder-net-btn').addEventListener('click', openDevices);
$('dlg-scan').addEventListener('click', () => scan(true));
$('dlg-forget').addEventListener('click', () => { api.forget(); toast('Remembered sensor forgotten. The next scan will ask.'); });
$('dlg-demo').addEventListener('click', () => { devDlg.close(); startDemo(); });
$('demo-btn').addEventListener('click', startDemo);
$('scan-btn').addEventListener('click', () => scan(true));
$('net-toggle').addEventListener('change', async (e) => {
  S.net = e.target.checked ? await api.netStart() : await api.netStop();
  renderNet();
});
$('net-copy').addEventListener('click', () => { api.copy($('net-url').textContent); toast('URL copied.'); });
$('net-token').addEventListener('click', async () => { S.net = await api.netNewToken(); renderNet(); toast('New token. Update the sending app.'); });
function renderNet() {
  const st = S.net;
  if (!st) return;
  $('net-toggle').checked = st.enabled;
  $('net-info').hidden = !st.enabled;
  const host = st.addresses[0] || 'localhost';
  $('net-url').textContent = `http://${host}:${st.port}/hr?bpm=72&token=${st.token}`;
  $('net-last').textContent = st.error ? `Error: ${st.error}` : st.lastAt ? `Last reading from ${st.lastSource}, ${shortDate.format(new Date(st.lastAt))}.` : 'Nothing received yet. macOS may ask to allow incoming connections.';
}

// Keys dialog
const keysDlg = $('keys-dialog');
const keysForm = $('keys-form');
function fillKeyRows(keys) {
  const rows = $('key-rows');
  rows.innerHTML = '';
  for (let k = 1; k <= 9; k++) {
    const row = document.createElement('div');
    row.className = 'key-row';
    row.innerHTML = `<kbd>${k}</kbd><input type="text" name="label${k}" placeholder="Unused" autocomplete="off" aria-label="Label for key ${k}"><label><input type="checkbox" name="phase${k}"> Phase</label>`;
    row.querySelector('input[type=text]').value = keys[k]?.label || '';
    row.querySelector('input[type=checkbox]').checked = keys[k] ? !!keys[k].phase : true;
    rows.appendChild(row);
  }
}
$('keys-btn').addEventListener('click', () => { fillKeyRows(S.keys); keysDlg.showModal(); keysForm.elements.label1.focus(); });
$('keys-reset').addEventListener('click', () => fillKeyRows(DEFAULT_KEYS));
keysForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const keys = {};
  for (let k = 1; k <= 9; k++) {
    const label = keysForm.elements[`label${k}`].value.trim();
    if (label) keys[k] = { label, phase: keysForm.elements[`phase${k}`].checked };
  }
  S.keys = keys;
  api.setState({ keys });
  renderKeys();
});

// ---------- Protocols ----------
const PR = window.PulseProtocols;
const allTpls = () => [...PR.BUILTIN, ...S.customTpls];
const findTpl = (id) => allTpls().find((t) => t.id === id);
let actx = null;
let protoTimer = null;

function beep(freq = 880, ms = 130, times = 1) {
  if (!S.audio.beeps) return;
  try {
    actx = actx || new AudioContext();
    for (let k = 0; k < times; k++) {
      const t = actx.currentTime + k * 0.2;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + ms / 1000 + 0.02);
    }
  } catch { /* audio unavailable */ }
}
function speak(text) {
  if (!S.audio.voice || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* speech unavailable */ }
}
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function protocolPlan(tpl) {
  return { id: tpl.id, name: tpl.name, auto_stop: !!tpl.autoStop, stages: PR.expand(tpl).map((s) => ({ label: s.label, planned_s: s.dur || null })) };
}
function startProtocol(tpl) {
  S.proto = { tpl, stages: PR.expand(tpl), i: -1, t0: 0, cd: 0 };
  clearInterval(protoTimer);
  protoTimer = setInterval(protoTick, 200);
  enterStage(0, Date.now());
  api.debug(`protocol start ${tpl.name} (${S.proto.stages.length} stages)`);
}
function enterStage(i, t = Date.now()) {
  const pr = S.proto;
  const st = pr.stages[i];
  pr.i = i;
  pr.t0 = t;
  pr.cd = 0;
  pushMarker({ key: `P${i + 1}`, label: st.label, phase: true, t });
  beep(880, 140, 2);
  speak(st.cue ? `${st.label}. ${st.cue}` : st.label);
  announce(`Stage ${i + 1}: ${st.label}`);
  renderProto();
}
function protoNext() {
  const pr = S.proto;
  if (!pr) return;
  if (pr.i + 1 >= pr.stages.length) finishProtocol();
  else enterStage(pr.i + 1);
}
function protoSkipBlock() {
  const pr = S.proto;
  if (!pr) return;
  let j = pr.i + 1;
  while (j < pr.stages.length && pr.stages[j].inBlock) j++;
  if (j >= pr.stages.length) finishProtocol();
  else enterStage(j);
}
function finishProtocol() {
  const tpl = S.proto.tpl;
  endProtocol({ silent: true });
  beep(660, 450, 1);
  speak('Protocol complete.');
  if (tpl.autoStop && S.rec) stopRecording();
  else toast(`Protocol “${tpl.name}” complete.`);
}
function endProtocol({ silent = false } = {}) {
  if (!S.proto) return;
  if (!silent) {
    pushMarker({ key: 'P', label: 'Protocol ended', phase: false, note: `at stage ${S.proto.i + 1} of ${S.proto.stages.length}` });
    speak('Protocol ended.');
  }
  clearInterval(protoTimer);
  protoTimer = null;
  S.proto = null;
  renderProto();
}
function protoTick() {
  const pr = S.proto;
  if (!pr) return;
  const st = pr.stages[pr.i];
  if (st.dur) {
    const left = st.dur * 1000 - (Date.now() - pr.t0);
    const secs = Math.ceil(left / 1000);
    if (secs >= 1 && secs <= 3 && secs !== pr.cd) { pr.cd = secs; beep(660, 90, 1); }
    if (left <= 0) {
      const endT = pr.t0 + st.dur * 1000; // keep the schedule exact
      if (pr.i + 1 >= pr.stages.length) return finishProtocol();
      return enterStage(pr.i + 1, endT);
    }
  }
  renderProtoTime();
}
function renderProto() {
  const pr = S.proto;
  $('proto-idle').hidden = !!pr;
  $('proto-run').hidden = !pr;
  if (!pr) return;
  const st = pr.stages[pr.i];
  const nx = pr.stages[pr.i + 1];
  $('proto-step').textContent = `${pr.tpl.name} · stage ${pr.i + 1} of ${pr.stages.length}`;
  $('proto-label').textContent = st.label;
  $('proto-cue').textContent = st.cue || '';
  $('proto-next').textContent = nx ? `Next: ${nx.label} · ${PR.fmtDur(nx.dur)}` : st.dur ? 'Last stage' : 'Last stage · press Finish when done';
  const skip = $('proto-skip');
  skip.hidden = !st.inBlock;
  if (st.inBlock) {
    let j = pr.i + 1;
    while (j < pr.stages.length && pr.stages[j].inBlock) j++;
    skip.textContent = pr.stages[j] ? `Skip to ${pr.stages[j].label}` : 'End repeats';
    skip.title = 'Jump past the repeated stages, for example when the participant stops a ramp test';
  }
  $('proto-nextbtn').textContent = nx ? 'Next stage' : 'Finish';
  const bar = $('proto-bar');
  bar.innerHTML = '';
  pr.stages.forEach((s, k) => {
    const el = document.createElement('span');
    el.style.flexGrow = String(Math.max(1, (s.dur || 60) / 30));
    if (k < pr.i) el.className = 'done';
    else if (k === pr.i) el.className = 'now';
    el.title = `${s.label} · ${PR.fmtDur(s.dur)}`;
    bar.appendChild(el);
  });
  renderProtoTime();
}
function renderProtoTime() {
  const pr = S.proto;
  if (!pr) return;
  const st = pr.stages[pr.i];
  const el = Date.now() - pr.t0;
  const t = $('proto-time');
  if (st.dur) {
    const left = Math.max(0, st.dur * 1000 - el);
    t.textContent = mmss(Math.ceil(left / 1000) * 1000);
    t.classList.toggle('ending', left <= 3000);
  } else {
    t.textContent = `+${mmss(el)}`;
    t.classList.remove('ending');
  }
}
$('proto-nextbtn').addEventListener('click', protoNext);
$('proto-skip').addEventListener('click', protoSkipBlock);
$('proto-end').addEventListener('click', () => endProtocol());

// Protocol picker
const protoDlg = $('proto-dialog');
const protoForm = $('proto-form');
function renderTplList() {
  const wrap = $('tpl-list');
  wrap.innerHTML = '';
  if (!findTpl(S.tplSel)) S.tplSel = PR.BUILTIN[0].id;
  for (const t of allTpls()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tpl';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(t.id === S.tplSel));
    b.tabIndex = t.id === S.tplSel ? 0 : -1;
    b.dataset.id = t.id;
    b.innerHTML = `<span class="tpl-name">${esc(t.name)}<span class="badge">${t.builtin ? 'Built-in' : 'Custom'}</span>${t.autoStop ? '<span class="badge" title="Stops the recording at the end">auto-stop</span>' : ''}</span>${t.description ? `<span class="tpl-desc">${esc(t.description)}</span>` : ''}<span class="tpl-sum">${esc(PR.summary(t))}</span>`;
    b.addEventListener('click', () => { S.tplSel = t.id; renderTplList(); wrap.querySelector(`[data-id="${CSS.escape(t.id)}"]`).focus(); });
    b.addEventListener('dblclick', () => { S.tplSel = t.id; protoForm.requestSubmit($('proto-start')); });
    wrap.appendChild(b);
  }
  const sel = findTpl(S.tplSel);
  $('tpl-edit').disabled = !sel || sel.builtin;
  $('tpl-del').disabled = !sel || sel.builtin;
}
$('tpl-list').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const list = allTpls();
  const i = list.findIndex((t) => t.id === S.tplSel);
  const n = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
  S.tplSel = n.id;
  renderTplList();
  $('tpl-list').querySelector(`[data-id="${CSS.escape(n.id)}"]`).focus();
});
function openProtoDialog() {
  if (S.proto) { toast('A protocol is already running. End it first.'); return; }
  renderTplList();
  $('opt-beeps').checked = S.audio.beeps;
  $('opt-voice').checked = S.audio.voice;
  const live = S.state === 'live' || S.state === 'stale';
  $('proto-start').disabled = !live;
  $('proto-start').textContent = S.rec ? 'Start now' : 'Start…';
  $('proto-start-hint').textContent = !live ? 'Connect a source first.' : S.rec ? `Runs inside “${S.rec.name}”.` : 'You name the recording next.';
  $('proto-error').hidden = true;
  protoDlg.showModal();
  $('tpl-list').querySelector('[aria-checked="true"]')?.focus();
}
$('proto-open').addEventListener('click', openProtoDialog);
for (const id of ['opt-beeps', 'opt-voice']) {
  $(id).addEventListener('change', () => {
    S.audio = { beeps: $('opt-beeps').checked, voice: $('opt-voice').checked };
    api.setState({ audio: S.audio });
    if (id === 'opt-beeps' && S.audio.beeps) beep(880, 120, 1);
    if (id === 'opt-voice' && S.audio.voice) speak('Voice cues on.');
  });
}
protoForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'start' && e.submitter?.id !== 'proto-start') return;
  const tpl = findTpl(S.tplSel);
  if (!tpl) { e.preventDefault(); return; }
  api.setState({ tplSel: tpl.id });
  if (S.rec) startProtocol(tpl);
  else { S.pendingProto = tpl; setTimeout(() => openRecDialog({ protocol: tpl.name }), 0); }
});
$('tpl-new').addEventListener('click', () => openTplEditor({ id: '', name: '', description: '', autoStop: true, stages: [{ label: 'Baseline', dur: 120, cue: '' }] }, 'new'));
$('tpl-dup').addEventListener('click', () => {
  const t = findTpl(S.tplSel);
  if (t) openTplEditor({ ...structuredClone(t), id: '', builtin: false, name: `${t.name} (copy)` }, 'new');
});
$('tpl-edit').addEventListener('click', () => { const t = findTpl(S.tplSel); if (t && !t.builtin) openTplEditor(structuredClone(t), 'edit'); });
$('tpl-del').addEventListener('click', () => {
  const t = findTpl(S.tplSel);
  if (!t || t.builtin) return;
  const before = S.customTpls;
  S.customTpls = S.customTpls.filter((x) => x.id !== t.id);
  api.setState({ protocols: S.customTpls });
  renderTplList();
  toast(`Deleted “${t.name}”.`, 'Undo', () => { S.customTpls = before; api.setState({ protocols: before }); S.tplSel = t.id; renderTplList(); }, 7000);
});

// Template editor
const tplDlg = $('tpl-dialog');
const tplForm = $('tpl-form');
let tplMode = { mode: 'new', id: '' };
function stageRow(s = { label: '', dur: 60, cue: '' }) {
  const li = document.createElement('li');
  li.className = 'stage-row';
  li.innerHTML = '<span class="num"></span><input type="text" data-k="label" placeholder="e.g. Stage…" autocomplete="off" aria-label="Stage label"><input type="text" data-k="dur" placeholder="open" autocomplete="off" aria-label="Duration, m:ss, empty for open-ended"><input type="text" data-k="cue" placeholder="What to do…" autocomplete="off" aria-label="Cue"><button class="m-del" type="button" aria-label="Remove stage">×</button>';
  li.querySelector('[data-k="label"]').value = s.label;
  li.querySelector('[data-k="dur"]').value = s.dur ? PR.fmtDur(s.dur) : '';
  li.querySelector('[data-k="cue"]').value = s.cue || '';
  li.querySelector('.m-del').addEventListener('click', () => { li.remove(); tplChanged(); });
  return li;
}
function readTpl() {
  const rows = [...$('stage-rows').children];
  const stages = rows.map((li) => ({
    label: li.querySelector('[data-k="label"]').value.trim(),
    dur: PR.parseDur(li.querySelector('[data-k="dur"]').value),
    cue: li.querySelector('[data-k="cue"]').value.trim(),
  }));
  const f = tplForm.elements;
  const t = { id: tplMode.id, name: f.name.value.trim(), description: f.description.value.trim(), autoStop: f.autoStop.checked, stages };
  if (f.repeatOn.checked) t.repeat = { from: Number(f.repeatFrom.value) - 1, to: Number(f.repeatTo.value) - 1, times: Number(f.repeatTimes.value) };
  return t;
}
function tplChanged() {
  const rows = [...$('stage-rows').children];
  const f = tplForm.elements;
  const on = f.repeatOn.checked;
  for (const x of ['repeatFrom', 'repeatTo', 'repeatTimes']) f[x].disabled = !on;
  const from = Number(f.repeatFrom.value) - 1;
  const to = Number(f.repeatTo.value) - 1;
  rows.forEach((li, i) => {
    li.querySelector('.num').textContent = i + 1;
    li.classList.toggle('in-rep', on && i >= from && i <= to);
  });
  $('tpl-error').hidden = true;
  const t = readTpl();
  const err = PR.validate(t);
  $('tpl-preview').textContent = err ? '' : `${PR.totals(t).count} stages: ${PR.summary(t)}`;
}
function openTplEditor(t, mode) {
  tplMode = { mode, id: t.id };
  $('tpl-title').textContent = mode === 'edit' ? 'Edit protocol' : 'New protocol';
  const f = tplForm.elements;
  f.name.value = t.name || '';
  f.description.value = t.description || '';
  f.autoStop.checked = !!t.autoStop;
  f.repeatOn.checked = !!(t.repeat && t.repeat.times > 1);
  f.repeatFrom.value = t.repeat ? t.repeat.from + 1 : 1;
  f.repeatTo.value = t.repeat ? t.repeat.to + 1 : 1;
  f.repeatTimes.value = t.repeat ? t.repeat.times : 4;
  const rows = $('stage-rows');
  rows.innerHTML = '';
  for (const s of t.stages) rows.appendChild(stageRow(s));
  $('tpl-error').hidden = true;
  tplChanged();
  tplDlg.showModal();
  f.name.focus();
}
tplForm.addEventListener('input', tplChanged);
$('stage-add').addEventListener('click', () => {
  const li = stageRow();
  $('stage-rows').appendChild(li);
  tplChanged();
  li.querySelector('input').focus();
});
tplForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const t = readTpl();
  const err = PR.validate(t);
  if (err) {
    e.preventDefault();
    $('tpl-error').hidden = false;
    $('tpl-error').textContent = err;
    return;
  }
  if (tplMode.mode === 'edit') S.customTpls = S.customTpls.map((x) => (x.id === t.id ? t : x));
  else { t.id = `custom-${crypto.randomUUID().slice(0, 8)}`; S.customTpls = [...S.customTpls, t]; }
  api.setState({ protocols: S.customTpls });
  S.tplSel = t.id;
  renderTplList();
});

// ---------- Registry ----------
async function loadRegistry() {
  S.registry = await api.registryList();
  renderRegistry();
}
function renderRegistry() {
  const q = $('reg-search').value.trim().toLowerCase();
  const list = S.registry.filter((s) => !q || `${s.name} ${s.participant} ${s.protocol}`.toLowerCase().includes(q));
  const ul = $('reg-list');
  ul.innerHTML = '';
  $('reg-empty').hidden = S.registry.length > 0;
  for (const s of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'reg-item';
    if (S.view === 'session' && S.current?.dir === s.dir) b.setAttribute('aria-current', 'true');
    const badges = [
      s.recording ? '<span class="badge rec">REC</span>' : '',
      s.incomplete ? '<span class="badge" title="Ended without a summary. Open and re-analyze.">incomplete</span>' : '',
      s.legacy ? '<span class="badge" title="Recorded with an earlier version. Open and re-analyze to upgrade.">old format</span>' : '',
      s.flags ? `<span class="badge flag" title="${s.flags} physiological flags">${s.flags} flag${s.flags > 1 ? 's' : ''}</span>` : '',
    ].join('');
    const line1 = [s.started_at ? shortDate.format(new Date(s.started_at)) : '', s.duration_s != null ? clock(s.duration_s * 1000) : ''].filter(Boolean).join(' · ');
    const line2 = [s.participant, s.avg_bpm != null ? `avg ${Math.round(s.avg_bpm)} bpm` : '', s.rmssd != null ? `RMSSD ${Math.round(s.rmssd)}` : '', s.anomalies ? `${s.anomalies} checks` : ''].filter(Boolean).join(' · ');
    b.innerHTML = `<span class="reg-name"><span class="nm">${esc(s.name)}</span>${badges}</span><span class="reg-line">${esc(line1)}</span>${line2 ? `<span class="reg-line">${esc(line2)}</span>` : ''}`;
    b.addEventListener('click', () => openSession(s.dir));
    li.appendChild(b);
    ul.appendChild(li);
  }
  if (S.registry.length && !list.length) ul.innerHTML = '<li class="reg-empty muted">No sessions match.</li>';
}
$('reg-search').addEventListener('input', renderRegistry);
$('reg-refresh').addEventListener('click', async () => { await loadRegistry(); toast('Sessions refreshed.', null, null, 1800); });
api.onRegistryChanged(() => loadRegistry());
$('folder-btn').addEventListener('click', () => api.openFolder());

// ---------- Views ----------
function showLive() {
  S.view = 'live';
  document.body.dataset.view = 'live';
  $('view-live').hidden = false;
  $('view-session').hidden = true;
  $('nav-live').setAttribute('aria-current', 'page');
  document.title = 'Pulse';
  renderRegistry();
  renderLive();
}
$('nav-live').addEventListener('click', showLive);

async function openSession(dir) {
  let data;
  try { data = await api.sessionLoad(dir); } catch (err) { toast(`Could not open session: ${err.message}`); loadRegistry(); return; }
  const beats = M.markArtifacts(M.beatsFrom(data.samples));
  S.current = { dir, ...data, beats };
  S.view = 'session';
  S.sHoverT = null;
  document.body.dataset.view = 'session';
  $('view-live').hidden = true;
  $('view-session').hidden = false;
  $('nav-live').removeAttribute('aria-current');
  document.title = `${data.meta.name} · Pulse`;
  renderRegistry();
  renderSession();
  $('view-session').querySelector('.session-scroll').scrollTop = 0;
}

function sessionTimes() {
  const { meta, samples } = S.current;
  const t0 = Date.parse(meta.started_at) || samples[0]?.t || Date.now();
  const t1 = Date.parse(meta.ended_at) || samples[samples.length - 1]?.t || t0 + 1000;
  return { t0, t1 };
}
function sessionEdges(meta) {
  const z = meta.zones;
  if (z?.start_bpm) return [z.start_bpm.z1, z.start_bpm.z2, z.start_bpm.z3, z.start_bpm.z4, z.start_bpm.z5, z.max_hr];
  return M.zoneEdges(meta.profile || {});
}

function renderSession() {
  const { meta } = S.current;
  const { t0 } = sessionTimes();
  const isRec = S.rec?.dir === S.current.dir;
  const legacy = meta.format !== 'pulse-session';
  $('s-name').value = meta.name || '';
  $('s-meta').textContent = [meta.participant && `Participant ${meta.participant}`, meta.protocol, meta.started_at && dateFmt.format(new Date(meta.started_at)), meta.duration_s != null && clock(meta.duration_s * 1000), meta.device].filter(Boolean).join(' · ');
  const banner = $('s-banner');
  banner.hidden = !(meta.recording || legacy);
  banner.textContent = isRec ? 'This session is still recording. Stop it from the live view to see its full analysis.'
    : legacy ? 'Recorded with an earlier version of Pulse. Press Re-analyze to compute the full analysis with your current profile. The original files are kept as *.original.csv / .json.'
    : 'This session ended without a summary (the app quit or crashed). Re-analyze to rebuild it from the raw files.';
  $('s-reanalyze').disabled = isRec;
  $('s-png').disabled = !!meta.recording || legacy;
  $('s-trash').disabled = isRec;

  const o = meta.overall || {};
  const q = meta.quality || {};
  const z = meta.zones || {};
  const hrr = (meta.recovery || []).find((r) => r.hrr60_bpm != null);
  const tiles = [
    ['Average HR', fmt(o.avg_bpm), 'bpm'],
    ['Max HR', fmt(o.max_bpm), z.max_hr && o.max_bpm ? `${Math.round((100 * o.max_bpm) / z.max_hr)}% of ${z.max_hr}` : 'bpm'],
    ['Min HR', fmt(o.min_bpm), 'bpm'],
    ['RMSSD', fmt(o.hrv?.rmssd_ms), 'ms, whole session'],
    ['SDNN', fmt(o.hrv?.sdnn_ms), 'ms, whole session'],
    ['TRIMP', fmt(meta.trimp_edwards, 1), 'Edwards'],
    ['HRR60', hrr ? fmt(hrr.hrr60_bpm) : '–', hrr ? `after ${hrr.label}` : 'no Recovery marker'],
    ['Artifacts', q.artifact_pct != null ? `${fmt(q.artifact_pct, 1)}%` : '–', `RR coverage ${fmt(q.rr_coverage_pct)}%`],
    ['Dropouts', q.dropout_s != null ? `${q.dropout_s}s` : '–', `${fmt(q.packets)} packets`],
  ];
  $('s-tiles').innerHTML = tiles.map(([l, v, s]) => `<div class="tile"><span class="tile-label">${esc(l)}</span><span class="tile-value">${esc(v)}</span><span class="tile-sub">${esc(s)}</span></div>`).join('');

  renderSessionChart();

  // Phases
  const ph = meta.phases || [];
  $('s-phases-empty').hidden = ph.length > 0;
  $('s-phases').innerHTML = ph.length ? `<thead><tr><th>Phase</th><th>Start</th><th>Duration</th><th>Avg</th><th>Max</th><th>Min</th><th>RMSSD</th><th>SDNN</th><th>DFA α1</th><th>LF/HF</th><th>Resp</th><th>Artifacts</th></tr></thead><tbody>${ph.map((p) => `<tr><td title="${esc(p.label)}">${esc(p.label)}</td><td>${clock(p.start_s * 1000)}</td><td>${clock(p.duration_s * 1000)}</td><td>${fmt(p.avg_bpm)}</td><td>${fmt(p.max_bpm)}</td><td>${fmt(p.min_bpm)}</td><td>${fmt(p.hrv?.rmssd_ms)}</td><td>${fmt(p.hrv?.sdnn_ms)}</td><td>${fmt(p.dfa_a1, 2)}</td><td>${fmt(p.spectral?.lf_hf, 2)}</td><td>${p.spectral?.resp_rate_bpm ? fmt(p.spectral.resp_rate_bpm, 1) : '–'}</td><td>${p.hrv ? `${fmt(p.hrv.artifact_pct, 1)}%` : '–'}</td></tr>`).join('')}</tbody>` : '';
  $('s-recovery').innerHTML = (meta.recovery || []).map((r) => `<span><strong>${esc(r.label)}</strong> at ${clock(r.at_s * 1000)}: peak ${r.peak_bpm} bpm, HRR60 ${fmt(r.hrr60_bpm)} bpm, HRR120 ${fmt(r.hrr120_bpm)} bpm</span>`).join('');

  // Anomalies
  const anoms = (meta.anomalies || []).map((a) => ({ ...a, t: t0 + a.at_s * 1000, t2: t0 + a.end_s * 1000 }));
  renderAnoms($('s-anoms'), $('s-anom-count'), anoms, t0, (a) => { S.sHoverT = a.t; renderSessionChart(); });
  if (!anoms.length) $('s-anoms').innerHTML = '<li class="muted">No anomalies detected.</li>';

  // Time in zones
  const secs = [0, 1, 2, 3, 4, 5].map((i) => meta.time_in_zone_s?.[`z${i}`] || 0);
  const cv = $('s-zt');
  const { ctx, w, h } = sizeCanvas(cv);
  C.zoneBar(ctx, { x: 0, y: 0, w, h }, secs, C.themeFromCSS());
  $('s-zt-legend').innerHTML = secs.map((s, i) => `<span><i class="zi${i}"></i>Z${i} ${clock(s * 1000)}</span>`).join('');

  // Details
  $('s-participant').value = meta.participant || '';
  $('s-protocol').value = meta.protocol || '';
  $('s-notes').value = meta.notes || '';
  $('s-saved').textContent = '';
  $('s-files').textContent = `Folder: ${S.current.dir.split('/').pop()} · heart_rate.csv, markers.csv, anomalies.csv, rr_intervals.txt (Kubios), session.json · analysis v${meta.analysis_version ?? '–'} · max HR ${z.max_hr ?? '–'} (${z.max_hr_source || '–'})`;
}

function renderSessionChart() {
  if (!S.current) return;
  const { meta, samples, markers, beats } = S.current;
  const { t0, t1 } = sessionTimes();
  const anoms = (meta.anomalies || []).map((a) => ({ ...a, t: t0 + a.at_s * 1000, t2: t0 + a.end_s * 1000 }));
  const { ctx, w, h } = sizeCanvas($('s-chart'));
  S.sLayout = C.draw(ctx, { x: 0, y: 0, w, h }, {
    samples, beats, markers, anomalies: anoms, edges: sessionEdges(meta), t0, t1, xMode: 'elapsed', origin: t0, hoverT: S.sHoverT,
  }, C.themeFromCSS());
}

// Session actions
async function saveDetails(patch) {
  if (!S.current) return;
  try {
    const res = await api.sessionUpdate(S.current.dir, patch);
    S.current.dir = res.dir;
    S.current.meta = { ...S.current.meta, ...res.meta };
    $('s-saved').textContent = 'Saved';
    document.title = `${S.current.meta.name} · Pulse`;
    $('s-meta').textContent = [S.current.meta.participant && `Participant ${S.current.meta.participant}`, S.current.meta.protocol, dateFmt.format(new Date(S.current.meta.started_at)), S.current.meta.duration_s != null && clock(S.current.meta.duration_s * 1000), S.current.meta.device].filter(Boolean).join(' · ');
    loadRegistry();
  } catch (err) { toast(err.message); }
}
$('s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = S.current.meta.name; e.target.blur(); } });
$('s-name').addEventListener('blur', () => {
  const v = $('s-name').value.trim();
  if (!S.current || v === S.current.meta.name) return;
  if (!v) { $('s-name').value = S.current.meta.name; toast('A session needs a name.'); return; }
  saveDetails({ name: v });
});
for (const [id, key] of [['s-participant', 'participant'], ['s-protocol', 'protocol'], ['s-notes', 'notes']]) {
  $(id).addEventListener('change', () => saveDetails({ [key]: $(id).value }));
}
$('s-reanalyze').addEventListener('click', async () => {
  const dir = S.current.dir;
  try {
    const legacy = S.current.meta.format !== 'pulse-session';
    await api.sessionReanalyze(dir, legacy ? S.profile : undefined);
    await openSession(dir);
    toast('Re-analyzed from the raw files.');
  } catch (err) { toast(`Re-analysis failed: ${err.message}`); }
});
$('s-png').addEventListener('click', async () => {
  const { meta, samples, markers, beats, dir } = S.current;
  const canvas = C.report(meta, samples, markers, beats);
  const url = canvas.toDataURL('image/png');
  const file = `${(meta.name || 'session').replace(/[\/\\:*?"<>|]+/g, ' ').trim()}.png`;
  const saved = await api.savePng(dir, url, file);
  if (saved) toast(`Exported ${saved.split('/').pop()}.`);
});
$('s-reveal').addEventListener('click', () => api.reveal(`${S.current.dir}/heart_rate.csv`));
$('s-trash').addEventListener('click', async () => {
  const ok = await api.sessionTrash(S.current.dir, S.current.meta.name).catch((err) => { toast(err.message); return false; });
  if (ok) { S.current = null; showLive(); toast('Session moved to the Trash.'); }
});

// Chart hover
function hover(canvasId, getLayout, set, redraw) {
  const cv = $(canvasId);
  cv.addEventListener('mousemove', (e) => {
    const L = getLayout();
    if (!L) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    set(x >= L.plot.x && x <= L.plot.x + L.plot.w ? L.tOf(x) : null);
    redraw();
  });
  cv.addEventListener('mouseleave', () => { set(null); redraw(); });
}
hover('chart', () => S.chartLayout, (t) => { S.hoverT = t; }, renderChart);
hover('s-chart', () => S.sLayout, (t) => { S.sHoverT = t; }, renderSessionChart);

// Chart range
$('range').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b) return;
  for (const x of $('range').children) x.setAttribute('aria-checked', String(x === b));
  S.range = b.dataset.range === 'all' ? 'all' : Number(b.dataset.range);
  api.setState({ range: b.dataset.range });
  renderChart();
});

// Toolbar
$('reset-btn').addEventListener('click', resetLive);
let pinned = false;
$('pin-btn').addEventListener('click', () => {
  pinned = !pinned;
  api.pin(pinned);
  $('pin-btn').setAttribute('aria-pressed', String(pinned));
  api.setState({ pinned });
});

// ---------- Ticker ----------
setInterval(() => {
  const now = Date.now();
  if ((S.state === 'live' || S.state === 'stale') && S.lastPacket) {
    const age = now - S.lastPacket;
    if (age > STALE_MS && S.state === 'live') setState('stale', S.source?.name, `No data for ${Math.round(age / 1000)} s`);
    else if (S.state === 'stale') {
      $('source-sub').textContent = `No data for ${Math.round(age / 1000)} s`;
      if (S.source?.kind === 'net' && age > 60000) { setState('idle', 'No source', 'Network input went quiet'); finder('Network input went quiet', 'No reading for a minute. Check the sending app, or pick another source.'); S.source = null; }
    }
  }
  if (S.view === 'live') { compute(); renderLive(); }
  if (S.rec) renderRecbar();
}, 1000);
window.addEventListener('resize', () => { if (S.view === 'live') renderLive(); else renderSession(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.view === 'live') renderLive(); else renderSession(); });

// ---------- Boot ----------
(async () => {
  const st = await api.getState();
  S.profile = { ...DEFAULT_PROFILE, ...(st.profile || {}) };
  S.edges = M.zoneEdges(S.profile);
  if (st.keys) S.keys = st.keys;
  if (Array.isArray(st.protocols)) S.customTpls = st.protocols;
  if (st.audio) S.audio = { ...S.audio, ...st.audio };
  if (st.tplSel) S.tplSel = st.tplSel;
  if (st.range) {
    S.range = st.range === 'all' ? 'all' : Number(st.range);
    for (const x of $('range').children) x.setAttribute('aria-checked', String(x.dataset.range === String(st.range)));
  }
  if (st.pinned) { pinned = true; api.pin(true); $('pin-btn').setAttribute('aria-pressed', 'true'); }
  if (st.lastDevice?.name) $('source-title').textContent = st.lastDevice.name;
  S.net = await api.netStatus();
  buildTiles();
  renderZoneScale();
  renderMarkers();
  renderProto();
  renderLive();
  loadRegistry();
  if (FAKE && S.state === 'idle') startDemo();
})();

// Main process calls this on launch with a user gesture so scanning starts by itself.
window.autoConnect = () => { if (S.state === 'idle' && !FAKE) scan(false); };

// Hooks for scripted tests (test instances only drive these through PULSE_SCRIPT).
window.__pulse = { S, addMarker, startProtocol, protoNext, protoSkipBlock, endProtocol, findTpl, openProtoDialog, openSession, showLive, loadRegistry, stopRecording, openRecDialog, report: () => C.report(S.current.meta, S.current.samples, S.current.markers, S.current.beats) };
