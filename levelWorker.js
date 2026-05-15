import { generateHardestLevel } from './generator.js';

self.onmessage = function ({ data }) {
  const { genId, width, height, seed, id, candidates, weights, useKeyDoor, useTeleporter, difficultyTarget } = data;
  try {
    const level = generateHardestLevel(width, height, { seed, id, candidates, weights, useKeyDoor, useTeleporter, difficultyTarget });
    self.postMessage({ genId, level });
  } catch (err) {
    console.error('[levelWorker] generation failed:', err);
    self.postMessage({ genId, level: null });
  }
};
