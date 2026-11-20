/*
 * Pulse metrics engine. Shared by the main process (analysis on save and
 * re-analysis) and the renderer (live view), so both always agree.
 *
 * Inputs
 *   samples: [{ t, bpm, rr: [ms], contact }]   one per received packet, t = epoch ms
 *   markers: [{ t, key, label, phase, note }]
 *   profile: { age, sex, restHr, maxHr, model: 'max' | 'hrr' }
 */
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root.PulseMetrics = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ANALYSIS_VERSION = 1;

  // ---------- Zones: standard 5-zone model, % of HRmax or % of HR reserve ----------
  const ZONES = [
    { z: 0, name: 'Rest', range: '< 50%' },
    { z: 1, name: 'Very light', range: '50–60%' },
    { z: 2, name: 'Light', range: '60–70%' },
    { z: 3, name: 'Moderate', range: '70–80%' },
    { z: 4, name: 'Hard', range: '80–90%' },
    { z: 5, name: 'Maximum', range: '90–100%' },
  ];

  const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);

  function maxHr(p = {}) {
    if (num(p.maxHr)) return Math.round(num(p.maxHr));
    if (num(p.age)) return Math.round(208 - 0.7 * num(p.age)); // Tanaka, Monahan & Seals 2001
    return 190;
  }
  function maxHrSource(p = {}) {
    if (num(p.maxHr)) return 'entered';
    if (num(p.age)) return 'estimated from age (Tanaka)';
    return 'default';
  }
  // Start bpm of zones 1..5 plus HRmax: [z1, z2, z3, z4, z5, max]
  function zoneEdges(p = {}) {
    const max = maxHr(p);
    const rest = p.model === 'hrr' && num(p.restHr) ? num(p.restHr) : 0;
    const at = (f) => Math.round(rest + f * (max - rest));
    return [at(0.5), at(0.6), at(0.7), at(0.8), at(0.9), max];
  }
  function zoneOf(bpm, edges) {
    for (let i = 4; i >= 0; i--) if (bpm >= edges[i]) return i + 1;
    return 0;
  }

  // ---------- Helpers ----------
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  }
  function median(a) {
    const s = [...a].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

  // ---------- Beats ----------
  // Spread the RR values of one packet back in time so each beat has its own timestamp.
  function beatsFrom(samples) {
    const beats = [];
    for (const s of samples) {
      if (!s.rr || !s.rr.length) continue;
      let back = 0;
      const local = [];
      for (let i = s.rr.length - 1; i >= 0; i--) {
        local.unshift({ t: s.t - back, ms: s.rr[i] });
        back += s.rr[i];
      }
      beats.push(...local);
    }
    return beats;
  }

  // Artifact detection: a beat is flagged when it is outside 300-2000 ms or
  // differs more than 20% from the median of the previous clean beats.
  // Five consecutive flagged beats that agree with each other (within 10%)
  // are accepted as a real rhythm change.
  function markArtifacts(beats) {
    let win = [];
    let run = [];
    for (const b of beats) {
      b.bad = false;
      b.kind = '';
      if (b.ms < 300 || b.ms > 2000) {
        b.bad = true;
        b.kind = 'out of range';
        continue;
      }
      if (win.length >= 5) {
        const med = median(win);
        const d = (b.ms - med) / med;
        if (Math.abs(d) > 0.2) {
          b.bad = true;
          b.kind = d > 0 ? 'long' : 'short';
          run.push(b);
          if (run.length >= 5) {
            const vals = run.map((x) => x.ms);
            if ((Math.max(...vals) - Math.min(...vals)) / median(vals) < 0.1) {
              for (const x of run) { x.bad = false; x.kind = ''; }
              win = vals.slice(-9);
              run = [];
            } else run.shift();
          }
          continue;
        }
      }
      run = [];
      win.push(b.ms);
      if (win.length > 9) win.shift();
    }
    return beats;
  }

  // ---------- Time domain HRV ----------
  function timeDomain(beats) {
    const good = beats.filter((b) => !b.bad).map((b) => b.ms);
    if (good.length < 10) return null;
    const diffs = [];
    for (let i = 1; i < beats.length; i++) {
      if (!beats[i].bad && !beats[i - 1].bad) diffs.push(beats[i].ms - beats[i - 1].ms);
    }
    const rmssd = diffs.length > 5 ? Math.sqrt(mean(diffs.map((d) => d * d))) : NaN;
    const sdsd = sd(diffs);
    return {
      mean_rr_ms: r1(mean(good)),
      sdnn_ms: r1(sd(good)),
      rmssd_ms: r1(rmssd),
      pnn50_pct: diffs.length ? r1((100 * diffs.filter((d) => Math.abs(d) > 50).length) / diffs.length) : null,
      sd1_ms: r1(sdsd / Math.SQRT2),
      sd2_ms: r1(Math.sqrt(Math.max(0, 2 * sd(good) ** 2 - sdsd ** 2 / 2))),
      beats: beats.length,
      artifact_pct: r1((100 * (beats.length - good.length)) / beats.length),
    };
  }

  // ---------- Frequency domain (Lomb-Scargle, works on uneven beat times) ----------
  function spectrum(beats) {
    const good = beats.filter((b) => !b.bad);
    if (good.length < 60) return null;
    const t0 = good[0].t;
    const ts = good.map((b) => (b.t - t0) / 1000);
    const dur = ts[ts.length - 1];
    if (dur < 110) return null;
    // remove linear trend
    const ys0 = good.map((b) => b.ms);
    const tm = mean(ts);
    const ym = mean(ys0);
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < ts.length; i++) { sxy += (ts[i] - tm) * (ys0[i] - ym); sxx += (ts[i] - tm) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const ys = ys0.map((y, i) => y - ym - slope * (ts[i] - tm));
    const varY = mean(ys.map((y) => y * y)) || 1;

    const bins = [];
    for (let f = 0.04; f <= 0.5 + 1e-9; f += 0.005) {
      const w = 2 * Math.PI * f;
      let s2 = 0;
      let c2 = 0;
      for (const t of ts) { s2 += Math.sin(2 * w * t); c2 += Math.cos(2 * w * t); }
      const tau = Math.atan2(s2, c2) / (2 * w);
      let yc = 0;
      let ysn = 0;
      let cc = 0;
      let ss = 0;
      for (let i = 0; i < ts.length; i++) {
        const c = Math.cos(w * (ts[i] - tau));
        const s = Math.sin(w * (ts[i] - tau));
        yc += ys[i] * c; ysn += ys[i] * s; cc += c * c; ss += s * s;
      }
      bins.push({ f, p: ((yc * yc) / cc + (ysn * ysn) / ss) / (2 * varY) });
    }
    const band = (lo, hi) => bins.filter((b) => b.f >= lo && b.f < hi).reduce((s, b) => s + b.p, 0);
    const lf = band(0.04, 0.15);
    const hf = band(0.15, 0.4);
    let peak = null;
    for (const b of bins) if (b.f >= 0.1 && b.f <= 0.5 && (!peak || b.p > peak.p)) peak = b;
    return {
      lf_hf: r2(hf ? lf / hf : NaN),
      lf_nu: r1((100 * lf) / (lf + hf)),
      hf_nu: r1((100 * hf) / (lf + hf)),
      resp_rate_bpm: peak ? r1(peak.f * 60) : null,
      duration_s: Math.round(dur),
    };
  }

  // ---------- DFA alpha 1 (box sizes 4-16 beats) ----------
  function dfaA1(beats) {
    const rr = beats.filter((b) => !b.bad).map((b) => b.ms);
    if (rr.length < 50) return null;
    const m = mean(rr);
    const y = [];
    let acc = 0;
    for (const v of rr) { acc += v - m; y.push(acc); }
    const xs = [];
    const fs = [];
    for (let n = 4; n <= 16; n++) {
      const boxes = Math.floor(y.length / n);
      if (boxes < 2) break;
      let f2 = 0;
      for (let b = 0; b < boxes; b++) {
        // least-squares line over the box
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < n; i++) { const yy = y[b * n + i]; sx += i; sy += yy; sxx += i * i; sxy += i * yy; }
        const k = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        const c = (sy - k * sx) / n;
        for (let i = 0; i < n; i++) f2 += (y[b * n + i] - (k * i + c)) ** 2;
      }
      xs.push(Math.log10(n));
      fs.push(Math.log10(Math.sqrt(f2 / (boxes * n))));
    }
    if (xs.length < 5) return null;
    const xm = mean(xs);
    const fm = mean(fs);
    let num1 = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) { num1 += (xs[i] - xm) * (fs[i] - fm); den += (xs[i] - xm) ** 2; }
    return r3(num1 / den);
  }
  function dfaLabel(a) {
    if (a == null) return '';
    if (a > 0.75) return 'below aerobic threshold';
    if (a >= 0.5) return 'between thresholds';
    return 'above anaerobic threshold';
  }

  // ---------- Load, zones, recovery ----------
  // Seconds in zone 0..5 and Edwards TRIMP (minutes in zone x zone number).
  function zoneTime(samples, edges) {
    const secs = [0, 0, 0, 0, 0, 0];
    for (let i = 1; i < samples.length; i++) {
      const dt = Math.min(samples[i].t - samples[i - 1].t, 5000) / 1000;
      if (samples[i].bpm > 0) secs[zoneOf(samples[i].bpm, edges)] += dt;
    }
    const trimp = secs.reduce((s, v, z) => s + (v / 60) * z, 0);
    return { secs: secs.map((v) => Math.round(v)), trimp: r1(trimp) };
  }

  function hrNear(samples, t, span = 2500) {
    const v = samples.filter((s) => Math.abs(s.t - t) <= span && s.bpm > 0).map((s) => s.bpm);
    return v.length ? mean(v) : null;
  }

  // HR recovery after every phase marker whose label mentions recovery or cool-down.
  function recoveries(samples, markers, now) {
    const out = [];
    for (const m of markers) {
      if (!m.phase || !/recover|cool/i.test(m.label)) continue;
      const before = samples.filter((s) => s.t <= m.t && s.t >= m.t - 30000 && s.bpm > 0).map((s) => s.bpm);
      if (!before.length) continue;
      const peak = Math.max(...before);
      const h60 = now >= m.t + 60000 ? hrNear(samples, m.t + 60000) : null;
      const h120 = now >= m.t + 120000 ? hrNear(samples, m.t + 120000) : null;
      out.push({
        t: m.t,
        label: m.label,
        peak_bpm: peak,
        hr60_bpm: r1(h60),
        hrr60_bpm: h60 != null ? r1(peak - h60) : null,
        hr120_bpm: r1(h120),
        hrr120_bpm: h120 != null ? r1(peak - h120) : null,
      });
    }
    return out;
  }

  // ---------- Anomalies ----------
  // Runs of consecutive samples matching pred, merged across gaps up to 3 s.
  function runs(samples, pred, minMs) {
    const out = [];
    let cur = null;
    for (const s of samples) {
      if (pred(s)) {
        if (cur && s.t - cur.t1 <= 3000) { cur.t1 = s.t; cur.vals.push(s.bpm); }
        else { if (cur) out.push(cur); cur = { t0: s.t, t1: s.t, vals: [s.bpm] }; }
      }
    }
    if (cur) out.push(cur);
    return out.filter((r) => r.t1 - r.t0 >= minMs);
  }

  function phaseRanges(markers, end) {
    const ph = markers.filter((m) => m.phase).sort((a, b) => a.t - b.t);
    return ph.map((m, i) => ({ label: m.label, t0: m.t, t1: ph[i + 1]?.t ?? end }));
  }

  function anomalies(samples, beats, markers, profile, end) {
    const out = [];
    const add = (type, severity, t, t2, title, detail) => out.push({ type, severity, t, t2: t2 ?? t, title, detail });
    const sec = (ms) => Math.round(ms / 1000);
    const max = maxHr(profile);

    for (let i = 1; i < samples.length; i++) {
      const gap = samples[i].t - samples[i - 1].t;
      if (gap > 5000) add('dropout', 'quality', samples[i - 1].t, samples[i].t, 'Signal dropout', `No data for ${sec(gap)} s`);
    }
    for (const r of runs(samples, (s) => s.bpm > 0 && (s.bpm < 30 || s.bpm > 230), 0)) {
      add('implausible', 'quality', r.t0, r.t1, 'Implausible heart rate', `${Math.min(...r.vals)}–${Math.max(...r.vals)} bpm is outside 30–230`);
    }
    let lastJump = -Infinity;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (a.bpm > 0 && b.bpm > 0 && b.t - a.t <= 2500 && Math.abs(b.bpm - a.bpm) >= 25 && b.t - lastJump > 10000) {
        add('jump', 'quality', b.t, null, 'Sudden jump', `${a.bpm} → ${b.bpm} bpm in ${((b.t - a.t) / 1000).toFixed(1)} s`);
        lastJump = b.t;
      }
    }
    // Flatline: same value for 60 s with no RR variation (or no RR at all).
    {
      let i0 = 0;
      for (let i = 1; i <= samples.length; i++) {
        if (i < samples.length && samples[i].bpm === samples[i0].bpm) continue;
        const seg = samples.slice(i0, i);
        if (seg.length && seg[seg.length - 1].t - seg[0].t >= 60000 && seg[0].bpm > 0) {
          const rr = seg.flatMap((s) => s.rr || []);
          if (rr.length < 5 || sd(rr) < 3) add('flatline', 'quality', seg[0].t, seg[seg.length - 1].t, 'Flatline', `${seg[0].bpm} bpm unchanged for ${sec(seg[seg.length - 1].t - seg[0].t)} s`);
        }
        i0 = i;
      }
    }
    for (const r of runs(samples, (s) => s.contact === 'no', 3000)) {
      add('contact', 'quality', r.t0, r.t1, 'No skin contact', `Sensor reported no contact for ${sec(r.t1 - r.t0)} s`);
    }
    // Artifact bursts: 5 or more flagged beats inside 30 s.
    {
      const bad = beats.filter((b) => b.bad);
      let j = 0;
      let open = null;
      for (let i = 0; i < bad.length; i++) {
        while (bad[i].t - bad[j].t > 30000) j++;
        if (i - j + 1 >= 5) {
          if (open && bad[j].t <= open.t2 + 5000) { open.t2 = bad[i].t; open.n = Math.max(open.n, i - j + 1); }
          else { if (open) out.push(open.done()); open = { t: bad[j].t, t2: bad[i].t, n: i - j + 1, done() { return { type: 'artifacts', severity: 'quality', t: this.t, t2: this.t2, title: 'Irregular beats', detail: `${this.n}+ RR intervals flagged within 30 s (ectopic beats or poor contact)` }; } }; }
        }
      }
      if (open) out.push(open.done());
    }
    for (const r of runs(samples, (s) => s.bpm > max, 5000)) {
      add('above-max', 'flag', r.t0, r.t1, 'Above max HR', `Peak ${Math.max(...r.vals)} bpm > max ${max}. Max HR may be set too low.`);
    }
    for (const r of runs(samples, (s) => s.bpm > 0 && s.bpm < 40, 30000)) {
      add('low-hr', 'flag', r.t0, r.t1, 'Low heart rate', `Under 40 bpm for ${sec(r.t1 - r.t0)} s`);
    }
    for (const ph of phaseRanges(markers, end)) {
      if (!/baseline|rest|supine|seated/i.test(ph.label)) continue;
      const inPh = samples.filter((s) => s.t >= ph.t0 && s.t < ph.t1);
      for (const r of runs(inPh, (s) => s.bpm > 100, 30000)) {
        add('elevated-rest', 'flag', r.t0, r.t1, 'Elevated resting HR', `Over 100 bpm during “${ph.label}” for ${sec(r.t1 - r.t0)} s`);
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // ---------- Summaries ----------
  function hrStats(samples) {
    const b = samples.map((s) => s.bpm).filter((v) => v > 0);
    if (!b.length) return { samples: 0 };
    return { samples: b.length, avg_bpm: r1(mean(b)), max_bpm: Math.max(...b), min_bpm: Math.min(...b) };
  }

  function windowStats(samples, beats, profile, t0, t1) {
    const s = samples.filter((x) => x.t >= t0 && x.t < t1);
    const b = beats.filter((x) => x.t >= t0 && x.t < t1);
    const td = timeDomain(b);
    const dur = (t1 - t0) / 1000;
    return {
      duration_s: Math.round(dur),
      ...hrStats(s),
      hrv: td,
      dfa_a1: dur >= 110 ? dfaA1(b) : null,
      spectral: dur >= 110 ? spectrum(b) : null,
      zones_s: zoneTime(s, zoneEdges(profile)).secs,
    };
  }

  // Full analysis of a recorded session.
  function analyze(samples, markers, profile, start, end) {
    samples = [...samples].sort((a, b) => a.t - b.t);
    markers = [...markers].sort((a, b) => a.t - b.t);
    const beats = markArtifacts(beatsFrom(samples));
    const edges = zoneEdges(profile);
    const zt = zoneTime(samples, edges);
    const rrCoverage = samples.length ? samples.filter((s) => s.rr && s.rr.length).length / samples.length : 0;
    const anoms = anomalies(samples, beats, markers, profile, end);
    const dropout = anoms.filter((a) => a.type === 'dropout').reduce((s, a) => s + (a.t2 - a.t), 0);
    return {
      analysis_version: ANALYSIS_VERSION,
      zones: {
        model: profile.model === 'hrr' && num(profile.restHr) ? '%HRR (Karvonen)' : '%HRmax',
        max_hr: maxHr(profile),
        max_hr_source: maxHrSource(profile),
        rest_hr: num(profile.restHr),
        start_bpm: { z1: edges[0], z2: edges[1], z3: edges[2], z4: edges[3], z5: edges[4] },
      },
      overall: windowStats(samples, beats, profile, start, end + 1),
      time_in_zone_s: Object.fromEntries(zt.secs.map((v, i) => [`z${i}`, v])),
      trimp_edwards: zt.trimp,
      phases: phaseRanges(markers, end).map((p) => ({
        label: p.label,
        start_s: r1((p.t0 - start) / 1000),
        end_s: r1((p.t1 - start) / 1000),
        ...windowStats(samples, beats, profile, p.t0, p.t1),
      })),
      recovery: recoveries(samples, markers, end).map((r) => ({ ...r, at_s: r1((r.t - start) / 1000) })),
      quality: {
        packets: samples.length,
        beats: beats.length,
        rr_coverage_pct: r1(rrCoverage * 100),
        artifact_pct: beats.length ? r1((100 * beats.filter((b) => b.bad).length) / beats.length) : null,
        dropout_s: Math.round(dropout / 1000),
      },
      anomalies: anoms.map((a) => ({ ...a, at_s: r1((a.t - start) / 1000), end_s: r1((a.t2 - start) / 1000) })),
      beats,
    };
  }

  // Live metrics over rolling windows. beats must already be marked.
  function live(samples, beats, profile, now) {
    const since = (ms) => samples.filter((s) => now - s.t <= ms && s.bpm > 0).map((s) => s.bpm);
    const bWin = (ms) => beats.filter((b) => now - b.t <= ms);
    const last = samples[samples.length - 1];
    const max = maxHr(profile);
    const rest = num(profile.restHr);
    const td60 = timeDomain(bWin(60000));
    const td120 = timeDomain(bWin(120000));
    const first = samples[0]?.t ?? now;
    return {
      bpm: last?.bpm ?? null,
      hr10: r1(mean(since(10000))),
      hr30: r1(mean(since(30000))),
      pct_max: last ? Math.round((100 * last.bpm) / max) : null,
      pct_hrr: last && rest ? Math.round((100 * (last.bpm - rest)) / (max - rest)) : null,
      rmssd: td60?.rmssd_ms ?? null,
      sdnn: td120?.sdnn_ms ?? null,
      pnn50: td120?.pnn50_pct ?? null,
      mean_rr: td60?.mean_rr_ms ?? null,
      artifact_pct: td60?.artifact_pct ?? null,
      rr_available: beats.length > 0,
      elapsed_ms: now - first,
    };
  }

  function liveSlow(beats, now) {
    const b120 = beats.filter((b) => now - b.t <= 120000);
    const b300 = beats.filter((b) => now - b.t <= 300000);
    const dfaArt = b120.length ? b120.filter((b) => b.bad).length / b120.length : 1;
    const dfa = b120.length && now - b120[0].t >= 100000 ? dfaA1(b120) : null;
    return {
      dfa_a1: dfa,
      dfa_reliable: dfaArt < 0.05,
      spectral: b300.length && now - b300[0].t >= 110000 ? spectrum(b300) : null,
    };
  }

  // ---------- CSV ----------
  function csvLine(line) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  function csvParse(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const head = csvLine(lines.shift() || '');
    return lines.map((l) => { const c = csvLine(l); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); });
  }

  return {
    ANALYSIS_VERSION, ZONES, maxHr, maxHrSource, zoneEdges, zoneOf,
    beatsFrom, markArtifacts, timeDomain, spectrum, dfaA1, dfaLabel,
    zoneTime, recoveries, anomalies, analyze, live, liveSlow, hrStats, phaseRanges,
    csvParse, mean, median,
  };
});
