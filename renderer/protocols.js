/*
 * Protocol templates: timed stages with cues. Running a protocol drops a phase
 * marker at every stage, so the session splits itself into phases.
 *
 * Template: { id, name, description, autoStop, stages: [{ label, dur, cue }], repeat?: { from, to, times } }
 *   dur is seconds; 0 means open-ended (the person presses Next).
 *   repeat repeats stages[from..to] (0-based, inclusive) `times` times, numbering their labels.
 */
(function (root) {
  'use strict';

  const BUILTIN = [
    {
      id: 'resting-hrv',
      name: 'Resting HRV (5 min)',
      description: 'Two minutes to settle, then five minutes of still, relaxed breathing. The standard short-term HRV recording.',
      autoStop: true,
      stages: [
        { label: 'Settle', dur: 120, cue: 'Lie down or sit still and breathe normally.' },
        { label: 'Rest', dur: 300, cue: 'Recording resting HRV. Stay still and relaxed.' },
      ],
    },
    {
      id: 'orthostatic',
      name: 'Orthostatic test',
      description: 'Five minutes lying down, then three minutes standing. Shows the heart rate response to standing up.',
      autoStop: true,
      stages: [
        { label: 'Supine', dur: 300, cue: 'Lie down and relax.' },
        { label: 'Standing', dur: 180, cue: 'Stand up now and stay still.' },
      ],
    },
    {
      id: 'ramp',
      name: 'Incremental ramp test',
      description: 'Baseline and warm-up, then 2-minute stages of rising intensity. Press Skip to Recovery when the participant stops; recovery and cool-down follow.',
      autoStop: false,
      stages: [
        { label: 'Baseline', dur: 120, cue: 'Sit still.' },
        { label: 'Warm-up', dur: 300, cue: 'Easy pace.' },
        { label: 'Stage', dur: 120, cue: 'Increase the intensity.' },
        { label: 'Recovery', dur: 120, cue: 'Stop. Recover in place.' },
        { label: 'Cool-down', dur: 0, cue: 'Easy movement. Press Next to finish.' },
      ],
      repeat: { from: 2, to: 2, times: 12 },
    },
    {
      id: 'intervals',
      name: 'Intervals 6 × 1 min',
      description: 'Ten-minute warm-up, six 1-minute efforts with 1-minute easy spells, five-minute cool-down.',
      autoStop: true,
      stages: [
        { label: 'Warm-up', dur: 600, cue: 'Easy pace.' },
        { label: 'Work', dur: 60, cue: 'Go hard.' },
        { label: 'Easy', dur: 60, cue: 'Back off.' },
        { label: 'Cool-down', dur: 300, cue: 'Easy pace.' },
      ],
      repeat: { from: 1, to: 2, times: 6 },
    },
    {
      id: 'hrr',
      name: 'Heart rate recovery test',
      description: 'An all-out effort of any length, then two minutes standing still. Gives HRR60 and HRR120.',
      autoStop: true,
      stages: [
        { label: 'Effort', dur: 0, cue: 'Go hard. Press Next when you stop.' },
        { label: 'Recovery', dur: 120, cue: 'Stop and stand still.' },
      ],
    },
  ].map((t) => ({ ...t, builtin: true }));

  function expand(t) {
    const out = [];
    const r = t.repeat && t.repeat.times > 1 ? t.repeat : null;
    t.stages.forEach((s, i) => {
      if (r && i === r.from) {
        for (let k = 1; k <= r.times; k++) {
          for (let j = r.from; j <= r.to; j++) out.push({ ...t.stages[j], label: `${t.stages[j].label} ${k}`, inBlock: true });
        }
      }
      if (r && i >= r.from && i <= r.to) return;
      out.push({ ...s, inBlock: false });
    });
    return out;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtDur(s) {
    if (!s) return 'open';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
  }
  // Accepts "2:00", "1:30:00", "90", "" or "open". Returns seconds (0 = open) or null when invalid.
  function parseDur(text) {
    const v = String(text || '').trim().toLowerCase();
    if (!v || v === 'open') return 0;
    if (/^\d+$/.test(v)) return Number(v);
    const parts = v.split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  function totals(t) {
    const st = expand(t);
    const timed = st.reduce((s, x) => s + (x.dur || 0), 0);
    const open = st.filter((x) => !x.dur).length;
    return { count: st.length, timed, open };
  }
  function summary(t) {
    const parts = t.stages.map((s, i) => {
      const inRep = t.repeat && t.repeat.times > 1 && i >= t.repeat.from && i <= t.repeat.to;
      return `${s.label} ${fmtDur(s.dur)}${inRep && i === t.repeat.to ? ` (×${t.repeat.times})` : ''}`;
    });
    const tt = totals(t);
    return `${parts.join(' → ')} · ${tt.timed ? fmtDur(tt.timed) : '0:00'}${tt.open ? ' + open' : ''}`;
  }

  function validate(t) {
    if (!t.name || !t.name.trim()) return 'Give the protocol a name.';
    if (!t.stages.length) return 'Add at least one stage.';
    for (const [i, s] of t.stages.entries()) {
      if (!s.label.trim()) return `Stage ${i + 1} needs a label.`;
      if (s.dur == null || s.dur < 0 || s.dur > 6 * 3600) return `Stage ${i + 1}: use a duration like 2:00, or leave it empty for open-ended.`;
    }
    if (t.repeat) {
      const { from, to, times } = t.repeat;
      if (!(from >= 0 && to >= from && to < t.stages.length)) return 'The repeat range must point at existing stages.';
      if (!(times >= 2 && times <= 50)) return 'Repeat between 2 and 50 times.';
    }
    return null;
  }

  root.PulseProtocols = { BUILTIN, expand, fmtDur, parseDur, totals, summary, validate };
})(typeof self !== 'undefined' ? self : this);
