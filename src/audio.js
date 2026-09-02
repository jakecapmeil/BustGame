/**
 * BUST — synthesised sound effects.
 *
 * Everything is generated with WebAudio so the game ships with zero audio
 * assets and still works offline. The context is created lazily on the first
 * user gesture, which is what mobile browsers require.
 */

let ctx = null;
let master = null;
let enabled = true;

export function setEnabled(v) {
  enabled = !!v;
  if (master) master.gain.value = enabled ? 0.9 : 0;
}
export function isEnabled() { return enabled; }

/** Call from a click/touch handler; safe to call repeatedly. */
export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = enabled ? 0.9 : 0;
  master.connect(ctx.destination);
}

function tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.2, slide = 0, delay = 0 }) {
  if (!ctx || !enabled) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(master);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.16, gain = 0.18, freq = 900, delay = 0 }) {
  if (!ctx || !enabled) return;
  const t0 = ctx.currentTime + delay;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(freq, t0);
  bp.frequency.exponentialRampToValueAtTime(freq * 0.35, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur);
}

export const sfx = {
  place() { tone({ freq: 520, dur: 0.09, type: 'triangle', gain: 0.16, slide: 140 }); },
  open()  { tone({ freq: 320, dur: 0.22, type: 'sawtooth', gain: 0.14, slide: 260 }); noise({ dur: 0.22, gain: 0.12 }); },
  /** Pitch climbs with the cascade depth so long chains feel like they build. */
  bust(depth = 0, size = 1) {
    const f = 180 * Math.pow(1.09, Math.min(depth, 18));
    noise({ dur: 0.16, gain: Math.min(0.26, 0.11 + size * 0.03), freq: 700 + depth * 60 });
    tone({ freq: f, dur: 0.14, type: 'square', gain: 0.10, slide: -f * 0.45 });
  },
  capture() { tone({ freq: 880, dur: 0.10, type: 'sine', gain: 0.10, slide: 240 }); },
  win() {
    [0, 4, 7, 12].forEach((s, k) => tone({
      freq: 440 * Math.pow(2, s / 12), dur: 0.3, type: 'triangle', gain: 0.16, delay: k * 0.1,
    }));
  },
  lose() {
    [0, -3, -7].forEach((s, k) => tone({
      freq: 380 * Math.pow(2, s / 12), dur: 0.34, type: 'sine', gain: 0.14, delay: k * 0.12,
    }));
  },
  ui() { tone({ freq: 660, dur: 0.05, type: 'sine', gain: 0.10 }); },
  deny() { tone({ freq: 150, dur: 0.12, type: 'square', gain: 0.10 }); },
};

/** Short haptic tick where the platform supports it. */
export function buzz(ms = 12) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ignore */ } }
}
