/**
 * Returns a seeded pseudo-random number generator.
 * Uses a standard LCG (Knuth, MMIX constants) — fast and deterministic.
 *
 * @param {number} seed  - integer seed; same seed → identical sequence
 * @returns {() => number}  - function returning floats in [0, 1)
 */
export function makeRng(seed = 0) {
  let s = seed >>> 0;
  return function rng() {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
