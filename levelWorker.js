import { generateHardestLevel } from './generator.js';

self.onmessage = function ({ data }) {
  const { width, height, seed, id, candidates, weights, useKeyDoor, difficultyTarget } = data;
  const level = generateHardestLevel(width, height, { seed, id, candidates, weights, useKeyDoor, difficultyTarget });
  self.postMessage(level);
};
