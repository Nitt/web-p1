// ── Procedural sound effects via Web Audio API ───────────────────────────────
// All sounds are synthesised — no external files required.
// AudioContext is created on first use (satisfies browser autoplay policy).

let _ctx = null;
let _masterNode = null;

function ctx() {
  if (!_ctx) _ctx = new AudioContext();
  return _ctx;
}

function now() { return ctx().currentTime; }

// Master gain — keeps all sounds from clipping
function master() {
  if (!_masterNode) {
    _masterNode = ctx().createGain();
    _masterNode.gain.value = 0.55;
    _masterNode.connect(ctx().destination);
  }
  return _masterNode;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function osc(type, freq, startGain, t0, duration, freqEnd) {
  const ac  = ctx();
  const o   = ac.createOscillator();
  const g   = ac.createGain();
  o.type    = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + duration);
  g.gain.setValueAtTime(startGain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  o.connect(g);
  g.connect(master());
  o.start(t0);
  o.stop(t0 + duration + 0.02);
}

function noise(startGain, t0, duration, lpFreq = 2000) {
  const ac     = ctx();
  const buf    = ac.createBuffer(1, ac.sampleRate * duration, ac.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src    = ac.createBufferSource();
  src.buffer   = buf;
  const lp     = ac.createBiquadFilter();
  lp.type      = 'lowpass';
  lp.frequency.value = lpFreq;
  const g      = ac.createGain();
  g.gain.setValueAtTime(startGain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(lp);
  lp.connect(g);
  g.connect(master());
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

// ── Public sound functions ────────────────────────────────────────────────────

/** Whoosh as the player slides. */
export function playSlide() {
  const t = now();
  noise(0.10, t, 0.12, 900);
  osc('sine', 320, 0.06, t, 0.12, 180);
}

/** Soft thud when the player lands on a cell. */
export function playLand() {
  const t = now();
  osc('sine', 140, 0.25, t, 0.10, 60);
  noise(0.06, t, 0.06, 400);
}

/** Player hits a wall — silent bump. */
export function playBlocked() {
  const t = now();
  osc('sine', 90, 0.12, t, 0.07, 70);
}

/** Crumble block shatters. */
export function playCrumble() {
  const t = now();
  noise(0.35, t, 0.22, 600);
  osc('sawtooth', 80, 0.18, t, 0.20, 35);
}

/** Level complete — rising fanfare. */
export function playWin() {
  const t = now();
  // Ascending triad arpeggio then held chord
  [[523, 0], [659, 0.10], [784, 0.20], [1047, 0.32]].forEach(([f, dt]) => {
    osc('sine',     f,       0.28, t + dt, 0.55);
    osc('triangle', f * 2,   0.10, t + dt, 0.45);
  });
}

// Browsers suspend AudioContext on tab hide and don't always auto-resume.
// Resume as soon as the tab becomes visible again so sounds keep working.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && _ctx?.state === 'suspended') {
    _ctx.resume();
  }
});
