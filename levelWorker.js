import { generateHardestLevel } from './generator.js';

self.onmessage = function ({ data }) {
  const { width, height, seed, id, candidates } = data;
  const level = generateHardestLevel(width, height, { seed, id, candidates });
  self.postMessage(level);
};
