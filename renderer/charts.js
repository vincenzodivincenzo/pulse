/* Pulse charts: one drawing routine for the live view, the session view and the PNG report. */
(function (root) {
  'use strict';
  const M = root.PulseMetrics;

  const LIGHT = {
    bg: '#ffffff', surface: '#ffffff', surface2: '#f1f3f5', border: 'rgba(20,28,36,0.12)', grid: 'rgba(20,28,36,0.08)',
    text: '#15191d', muted: '#5f6872', accent: '#d93d42', warn: '#c27c0e',
    z: ['#c3cad1', '#8a96a3', '#3b82e0', '#22a06b', '#e09b1b', '#e5484d'],
  };

  function themeFromCSS() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: v('--bg'), surface: v('--surface'), surface2: v('--surface-2'), border: v('--border'), grid: v('--grid'),
      text: v('--text'), muted: v('--muted'), accent: v('--accent'), warn: v('--warn'),
      z: [v('--z0'), v('--z1'), v('--z2'), v('--z3'), v('--z4'), v('--z5')],
    };
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
  }
  function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s === 0) return 'now';
    if (s % 60 === 0) return `-${s / 60}m`;
    return s > 60 ? `-${Math.floor(s / 60)}:${pad2(s % 60)}` : `-${s}s`;
  }

  function niceStep(spanMs, maxTicks) {
    const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);
    return steps.find((s) => spanMs / s <= maxTicks) || 7200000;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
  }

  /*
   * draw(ctx, rect, data, theme)
   * data: { samples, beats, markers, anomalies, edges, t0, t1, xMode: 'ago'|'elapsed', origin, hoverT, tacho, font }
   * Returns { xOf, tOf, plot } for hit testing.
   */
  function draw(ctx, rect, d, th) {
    const { x: rx, y: ry, w, h } = rect;
    const font = d.font || '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    const mono = 'ui-monospace, "SF Mono", Menlo, monospace';
    const padL = 4, padR = 40, padT = 26, padB = 20;
    const px = rx + padL;
    const pw = w - padL - padR;
    const showTacho = d.tacho !== false;
    const gap = showTacho ? 16 : 0;
    const usable = h - padT - padB - gap;
    const hrH = showTacho ? Math.round(usable * 0.68) : usable;
    const hrY = ry + padT;
    const taY = hrY + hrH + gap;
    const taH = usable - hrH;
    const t0 = d.t0, t1 = Math.max(d.t1, d.t0 + 1000);
    const xOf = (t) => px + ((t - t0) / (t1 - t0)) * pw;
    const tOf = (x) => t0 + ((x - px) / pw) * (t1 - t0);

    const samples = (d.samples || []).filter((s) => s.t >= t0 - 5000 && s.t <= t1 && s.bpm > 0);
    let lo = 50, hi = 150;
    if (samples.length) {
      lo = Infinity; hi = -Infinity;
      for (const s of samples) { if (s.bpm < lo) lo = s.bpm; if (s.bpm > hi) hi = s.bpm; }
    }
    lo = Math.floor((lo - 6) / 10) * 10;
    hi = Math.ceil((hi + 6) / 10) * 10;
    if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 20) / 10) * 10; hi = lo + 40; }
    const yOf = (v) => hrY + hrH - ((v - lo) / (hi - lo)) * hrH;

    ctx.save();
    ctx.beginPath(); ctx.rect(px, hrY, pw, hrH); ctx.clip();

    // Zone bands
    const e = d.edges || [95, 114, 133, 152, 171, 190];
    const bounds = [-Infinity, e[0], e[1], e[2], e[3], e[4], Infinity];
    for (let z = 0; z < 6; z++) {
      const a = Math.max(lo, bounds[z]);
      const b = Math.min(hi, bounds[z + 1]);
      if (b <= a) continue;
      ctx.globalAlpha = z === 0 ? 0.05 : 0.1;
      ctx.fillStyle = th.z[z];
      ctx.fillRect(px, yOf(b), pw, yOf(a) - yOf(b));
    }
    ctx.globalAlpha = 1;

    // Phase shading
    const phases = M.phaseRanges(d.markers || [], t1);
    phases.forEach((p, i) => {
      if (p.t1 < t0 || p.t0 > t1) return;
      const a = Math.max(px, xOf(p.t0));
      const b = Math.min(px + pw, xOf(p.t1));
      if (i % 2 === 0) { ctx.fillStyle = th.text; ctx.globalAlpha = 0.035; ctx.fillRect(a, hrY, b - a, hrH); ctx.globalAlpha = 1; }
      if (b - a > 46) {
        ctx.fillStyle = th.muted;
        ctx.font = `600 10.5px ${font}`;
        ctx.textBaseline = 'top';
        let label = p.label;
        while (label.length > 3 && ctx.measureText(label).width > b - a - 10) label = label.slice(0, -2);
        if (label !== p.label) label += '…';
        ctx.fillText(label, a + 5, hrY + 4);
        ctx.textBaseline = 'alphabetic';
      }
    });
    ctx.restore();

    // Grid + y labels
    ctx.font = `10.5px ${font}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.grid;
    ctx.fillStyle = th.muted;
    ctx.textBaseline = 'middle';
    const step = hi - lo > 100 ? 40 : hi - lo > 60 ? 20 : 10;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, yy); ctx.lineTo(px + pw, yy); ctx.stroke();
      ctx.fillText(String(v), px + pw + 7, yy);
    }
    ctx.fillText('bpm', px + pw + 7, hrY - 10);

    // X labels
    ctx.textBaseline = 'alphabetic';
    const span = t1 - t0;
    const xs = niceStep(span, Math.max(3, Math.floor(pw / 120)));
    ctx.textAlign = 'center';
    if (d.xMode === 'ago') {
      for (let k = 0; k * xs <= span; k++) {
        const t = t1 - k * xs;
        const xx = xOf(t);
        ctx.fillText(ago(t1 - t), Math.max(px + 14, Math.min(xx, px + pw - 12)), ry + h - 4);
      }
    } else {
      const origin = d.origin ?? t0;
      const first = Math.ceil((t0 - origin) / xs) * xs + origin;
      for (let t = first; t <= t1; t += xs) ctx.fillText(clock(t - origin), Math.max(px + 16, Math.min(xOf(t), px + pw - 16)), ry + h - 4);
    }
    ctx.textAlign = 'left';

    // HR line
    ctx.save();
    ctx.beginPath(); ctx.rect(px, hrY - 2, pw, hrH + 4); ctx.clip();
    ctx.strokeStyle = th.text;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let prev = null;
    for (const s of samples) {
      if (!prev || s.t - prev.t > 5000) ctx.moveTo(xOf(s.t), yOf(s.bpm));
      else ctx.lineTo(xOf(s.t), yOf(s.bpm));
      prev = s;
    }
    ctx.stroke();
    ctx.restore();

    // Anomaly strips along the bottom of the HR panel
    for (const a of d.anomalies || []) {
      if (a.t2 < t0 || a.t > t1) continue;
      const x1 = Math.max(px, xOf(a.t));
      const x2 = Math.min(px + pw, xOf(a.t2));
      ctx.fillStyle = a.severity === 'flag' ? th.accent : th.warn;
      ctx.fillRect(x1, hrY + hrH - 4, Math.max(3, x2 - x1), 4);
    }

    // Markers
    ctx.font = `600 10px ${mono}`;
    const rowRight = [-Infinity, -Infinity];
    for (const m of d.markers || []) {
      if (m.t < t0 || m.t > t1) continue;
      const xx = Math.round(xOf(m.t)) + 0.5;
      const tw = ctx.measureText(m.key).width + 8;
      const bx = Math.min(Math.max(xx - tw / 2, px), px + pw - tw);
      const row = bx > rowRight[0] + 2 ? 0 : bx > rowRight[1] + 2 ? 1 : 0;
      rowRight[row] = bx + tw;
      const by = ry + 2 + row * 12;
      ctx.save();
      ctx.strokeStyle = m.phase ? th.text : th.muted;
      ctx.globalAlpha = m.phase ? 0.5 : 0.7;
      ctx.setLineDash(m.phase ? [] : [3, 3]);
      ctx.beginPath(); ctx.moveTo(xx, by + 12); ctx.lineTo(xx, showTacho ? taY + taH : hrY + hrH); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = m.phase ? th.text : th.surface2;
      ctx.beginPath(); ctx.roundRect(bx, by, tw, 12, 3); ctx.fill();
      ctx.fillStyle = m.phase ? th.surface : th.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(m.key, bx + tw / 2, by + 6.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // Tachogram (RR intervals)
    if (showTacho) {
      const beats = (d.beats || []).filter((b) => b.t >= t0 && b.t <= t1);
      const good = beats.filter((b) => !b.bad).map((b) => b.ms).sort((a, b) => a - b);
      let rlo = percentile(good, 1), rhi = percentile(good, 99);
      if (!Number.isFinite(rlo)) { rlo = 600; rhi = 1000; }
      const padv = Math.max(20, (rhi - rlo) * 0.15);
      rlo -= padv; rhi += padv;
      const ryOf = (v) => taY + taH - ((Math.min(Math.max(v, rlo), rhi) - rlo) / (rhi - rlo)) * taH;
      ctx.strokeStyle = th.grid;
      ctx.strokeRect(px + 0.5, taY + 0.5, pw - 1, taH - 1);
      ctx.fillStyle = th.muted;
      ctx.font = `10.5px ${font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.round(rhi)), px + pw + 7, taY + 6);
      ctx.fillText(String(Math.round(rlo)), px + pw + 7, taY + taH - 6);
      ctx.fillText('RR ms', px + pw + 7, taY + taH / 2);
      ctx.textBaseline = 'alphabetic';
      if (!beats.length) {
        ctx.fillText(d.rrHint || 'No RR intervals from this source', px + 8, taY + taH / 2 + 4);
      } else {
        ctx.save();
        ctx.beginPath(); ctx.rect(px, taY, pw, taH); ctx.clip();
        ctx.strokeStyle = th.text;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 1;
        ctx.beginPath();
        let pb = null;
        for (const b of beats) {
          if (b.bad) continue;
          if (!pb || b.t - pb.t > 4000) ctx.moveTo(xOf(b.t), ryOf(b.ms)); else ctx.lineTo(xOf(b.t), ryOf(b.ms));
          pb = b;
        }
        ctx.stroke();
        ctx.globalAlpha = 0.8;
        const r = beats.length > 1500 ? 0.9 : 1.5;
        ctx.fillStyle = th.text;
        for (const b of beats) if (!b.bad) { ctx.beginPath(); ctx.arc(xOf(b.t), ryOf(b.ms), r, 0, 6.283); ctx.fill(); }
        ctx.globalAlpha = 1;
        ctx.fillStyle = th.accent;
        for (const b of beats) if (b.bad) { ctx.beginPath(); ctx.arc(xOf(b.t), ryOf(b.ms), 2.4, 0, 6.283); ctx.fill(); }
        ctx.restore();
      }
    }

    // Empty state
    if (!samples.length) {
      ctx.fillStyle = th.muted;
      ctx.font = `12px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText(d.emptyText || 'Heart rate will appear here', px + pw / 2, hrY + hrH / 2);
      ctx.textAlign = 'left';
    }

    // Hover readout
    if (d.hoverT != null && d.hoverT >= t0 && d.hoverT <= t1 && samples.length) {
      let best = samples[0];
      for (const s of samples) if (Math.abs(s.t - d.hoverT) < Math.abs(best.t - d.hoverT)) best = s;
      const xx = Math.round(xOf(best.t)) + 0.5;
      ctx.strokeStyle = th.text;
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(xx, hrY); ctx.lineTo(xx, showTacho ? taY + taH : hrY + hrH); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.text;
      ctx.beginPath(); ctx.arc(xx, yOf(best.bpm), 3.5, 0, 6.283); ctx.fill();
      const when = d.xMode === 'ago' ? ago(t1 - best.t) : clock(best.t - (d.origin ?? t0));
      const rr = best.rr && best.rr.length ? ` · RR ${best.rr.join(', ')} ms` : '';
      const z = d.edges ? ` · Z${M.zoneOf(best.bpm, d.edges)}` : '';
      const label = `${when} · ${best.bpm} bpm${z}${rr}`;
      ctx.font = `600 11px ${font}`;
      const tw = ctx.measureText(label).width + 14;
      const bx = Math.min(Math.max(xx + 8, px), px + pw - tw);
      const by = hrY + 18;
      ctx.fillStyle = th.surface;
      ctx.strokeStyle = th.border;
      ctx.beginPath(); ctx.roundRect(bx, by, tw, 22, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = th.text;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 7, by + 11.5);
      ctx.textBaseline = 'alphabetic';
    }

    return { xOf, tOf, plot: { x: px, y: hrY, w: pw, h: showTacho ? taY + taH - hrY : hrH } };
  }

  // Stacked bar of time in zones.
  function zoneBar(ctx, rect, secs, th, opts = {}) {
    const total = secs.reduce((s, v) => s + v, 0);
    const { x, y, w, h } = rect;
    ctx.fillStyle = th.surface2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill();
    if (!total) return;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.clip();
    let cx = x;
    secs.forEach((s, z) => {
      const ww = (s / total) * w;
      ctx.fillStyle = th.z[z];
      ctx.fillRect(cx, y, ww, h);
      cx += ww;
    });
    ctx.restore();
    if (opts.legend) {
      ctx.font = `11px ${opts.font || 'system-ui'}`;
      let lx = x;
      const ly = y + h + 16;
      secs.forEach((s, z) => {
        const label = `Z${z} ${clock(s * 1000)}`;
        ctx.fillStyle = th.z[z];
        ctx.fillRect(lx, ly - 8, 8, 8);
        ctx.fillStyle = th.text;
        ctx.fillText(label, lx + 12, ly);
        lx += ctx.measureText(label).width + 26;
      });
    }
  }

  function wrap(ctx, text, maxW) {
    const out = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
      }
      out.push(line);
    }
    return out;
  }

  const fmt = (v, unit = '') => (v == null || !Number.isFinite(+v) ? '–' : `${v}${unit}`);

  // Session report PNG (always light theme for printing and sharing).
  function report(meta, samples, markers, beats) {
    const th = LIGHT;
    const W = 1200;
    const S = 2;
    const font = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif';
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `13px ${font}`;
    const noteLines = meta.notes ? wrap(measure, meta.notes, W - 96) : [];
    const anoms = (meta.anomalies || []).slice(0, 12);
    const phases = meta.phases || [];
    const H = 920 + phases.length * 26 + (phases.length ? 60 : 0) + (anoms.length ? 50 + anoms.length * 22 : 40) + (noteLines.length ? 40 + noteLines.length * 19 : 0) + ((meta.recovery || []).length ? 40 : 0);

    const canvas = document.createElement('canvas');
    canvas.width = W * S;
    canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);
    const L = 48;
    let y = 52;

    ctx.fillStyle = th.muted;
    ctx.font = `600 12px ${font}`;
    ctx.fillText('PULSE · SESSION REPORT', L, y);
    y += 34;
    ctx.fillStyle = th.text;
    ctx.font = `700 28px ${font}`;
    ctx.fillText(meta.name || 'Untitled session', L, y);
    y += 26;
    const start = new Date(meta.started_at);
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(start);
    const metaLine = [meta.participant && `Participant ${meta.participant}`, meta.protocol, when, `Duration ${clock((meta.duration_s || 0) * 1000)}`, meta.device].filter(Boolean).join('   ·   ');
    ctx.font = `14px ${font}`;
    ctx.fillStyle = th.muted;
    ctx.fillText(metaLine, L, y);
    y += 22;
    const z = meta.zones || {};
    const prof = meta.profile || {};
    const profLine = [
      `Max HR ${z.max_hr ?? '–'} (${z.max_hr_source || '–'})`,
      z.rest_hr ? `Resting HR ${z.rest_hr}` : null,
      prof.age ? `Age ${prof.age}` : null,
      prof.sex ? `Sex ${prof.sex}` : null,
      `Zones ${z.model || '%HRmax'}`,
      `Analysis v${meta.analysis_version ?? '–'}`,
    ].filter(Boolean).join('   ·   ');
    ctx.fillText(profLine, L, y);
    y += 30;

    // Summary tiles
    const o = meta.overall || {};
    const q = meta.quality || {};
    const tiles = [
      ['Average HR', fmt(o.avg_bpm), 'bpm'],
      ['Max HR', fmt(o.max_bpm), z.max_hr && o.max_bpm ? `${Math.round((100 * o.max_bpm) / z.max_hr)}% of max` : 'bpm'],
      ['Min HR', fmt(o.min_bpm), 'bpm'],
      ['RMSSD', fmt(o.hrv?.rmssd_ms), 'ms, whole session'],
      ['TRIMP', fmt(meta.trimp_edwards), 'Edwards'],
      ['Artifacts', fmt(q.artifact_pct, '%'), `RR coverage ${fmt(q.rr_coverage_pct, '%')}`],
    ];
    const tw = (W - 2 * L - 5 * 12) / 6;
    tiles.forEach(([label, value, sub], i) => {
      const tx = L + i * (tw + 12);
      ctx.fillStyle = th.surface2;
      ctx.beginPath(); ctx.roundRect(tx, y, tw, 78, 10); ctx.fill();
      ctx.fillStyle = th.muted; ctx.font = `600 11.5px ${font}`; ctx.fillText(label, tx + 14, y + 22);
      ctx.fillStyle = th.text; ctx.font = `700 26px ${font}`; ctx.fillText(value, tx + 14, y + 52);
      ctx.fillStyle = th.muted; ctx.font = `11px ${font}`; ctx.fillText(sub, tx + 14, y + 68);
    });
    y += 104;

    // Chart
    const t0 = Date.parse(meta.started_at);
    const t1 = Date.parse(meta.ended_at) || samples[samples.length - 1]?.t || t0 + 1000;
    const edges = z.start_bpm ? [z.start_bpm.z1, z.start_bpm.z2, z.start_bpm.z3, z.start_bpm.z4, z.start_bpm.z5, z.max_hr] : null;
    const anomT = (meta.anomalies || []).map((a) => ({ ...a, t: t0 + a.at_s * 1000, t2: t0 + a.end_s * 1000 }));
    draw(ctx, { x: L, y, w: W - 2 * L, h: 420 }, { samples, beats, markers, anomalies: anomT, edges, t0, t1, xMode: 'elapsed', origin: t0, font }, th);
    y += 446;

    // Time in zones
    ctx.fillStyle = th.text; ctx.font = `700 15px ${font}`;
    ctx.fillText('Time in zones', L, y);
    y += 14;
    const secs = [0, 1, 2, 3, 4, 5].map((i) => meta.time_in_zone_s?.[`z${i}`] || 0);
    zoneBar(ctx, { x: L, y, w: W - 2 * L, h: 12 }, secs, th, { legend: true, font });
    y += 56;

    // Phase table
    if (phases.length) {
      ctx.fillStyle = th.text; ctx.font = `700 15px ${font}`;
      ctx.fillText('Phases', L, y);
      y += 24;
      const cols = [['Phase', 0], ['Start', 260], ['Duration', 340], ['Avg', 440], ['Max', 500], ['Min', 560], ['RMSSD', 630], ['SDNN', 710], ['pNN50', 790], ['DFA α1', 870], ['LF/HF', 960], ['Resp', 1030]];
      ctx.font = `600 11.5px ${font}`; ctx.fillStyle = th.muted;
      for (const [c, cx] of cols) ctx.fillText(c, L + cx, y);
      y += 8;
      ctx.strokeStyle = th.border; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - L, y); ctx.stroke();
      ctx.font = `13px ${font}`; ctx.fillStyle = th.text;
      for (const p of phases) {
        y += 22;
        const vals = [p.label, clock(p.start_s * 1000), clock(p.duration_s * 1000), fmt(p.avg_bpm), fmt(p.max_bpm), fmt(p.min_bpm), fmt(p.hrv?.rmssd_ms), fmt(p.hrv?.sdnn_ms), fmt(p.hrv?.pnn50_pct, '%'), fmt(p.dfa_a1), fmt(p.spectral?.lf_hf), p.spectral?.resp_rate_bpm ? `${p.spectral.resp_rate_bpm}/min` : '–'];
        vals.forEach((v, i) => {
          let s = String(v);
          if (i === 0) while (s.length > 3 && ctx.measureText(s).width > 250) s = s.slice(0, -2) + '…';
          ctx.fillText(s, L + cols[i][1], y);
        });
        y += 4;
      }
      y += 30;
    }

    if ((meta.recovery || []).length) {
      ctx.fillStyle = th.text; ctx.font = `13px ${font}`;
      const r = meta.recovery.map((x) => `${x.label} at ${clock(x.at_s * 1000)}: peak ${x.peak_bpm}, HRR60 ${fmt(x.hrr60_bpm)} bpm, HRR120 ${fmt(x.hrr120_bpm)} bpm`).join('   ·   ');
      ctx.fillText(`Heart rate recovery   ${r}`, L, y);
      y += 40;
    }

    // Anomalies
    ctx.fillStyle = th.text; ctx.font = `700 15px ${font}`;
    ctx.fillText(`Anomalies (${(meta.anomalies || []).length})`, L, y);
    y += 22;
    ctx.font = `13px ${font}`;
    if (!anoms.length) { ctx.fillStyle = th.muted; ctx.fillText('None detected.', L, y); y += 22; }
    for (const a of anoms) {
      ctx.fillStyle = a.severity === 'flag' ? th.accent : th.warn;
      ctx.beginPath(); ctx.arc(L + 4, y - 4, 4, 0, 6.283); ctx.fill();
      ctx.fillStyle = th.muted; ctx.fillText(clock(a.at_s * 1000), L + 16, y);
      ctx.fillStyle = th.text; ctx.font = `600 13px ${font}`; ctx.fillText(a.title, L + 80, y);
      const tw2 = ctx.measureText(a.title).width;
      ctx.font = `13px ${font}`; ctx.fillStyle = th.muted; ctx.fillText(a.detail, L + 90 + tw2, y);
      y += 22;
    }
    if ((meta.anomalies || []).length > anoms.length) { ctx.fillStyle = th.muted; ctx.fillText(`+ ${(meta.anomalies.length - anoms.length)} more in anomalies.csv`, L, y); y += 22; }
    y += 18;

    if (noteLines.length) {
      ctx.fillStyle = th.text; ctx.font = `700 15px ${font}`;
      ctx.fillText('Notes', L, y);
      y += 22;
      ctx.font = `13px ${font}`;
      for (const l of noteLines) { ctx.fillText(l, L, y); y += 19; }
      y += 18;
    }

    ctx.fillStyle = th.muted; ctx.font = `11.5px ${font}`;
    ctx.fillText(`Generated by Pulse on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}. For research and training use, not a medical device.`, L, H - 28);
    return canvas;
  }

  root.PulseCharts = { draw, zoneBar, report, themeFromCSS, clock, LIGHT };
})(typeof self !== 'undefined' ? self : this);
