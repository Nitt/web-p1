import { slidePlayer } from './puzzle.js';

/**
 * BFS pathfinder — returns the shortest sequence of moves to solve a level.
 *
 * @param {object} level       - current level object
 * @param {{x,y}} startPos     - current player position
 * @param {number} worldState  - current world state bitmask
 * @param {Map<number,number>} toggleMap
 * @returns {{dx:number,dy:number}[]|null} move sequence, or null if unsolvable
 */
export function solve(level, startPos, worldState, toggleMap) {
  const { width, height, goal } = level;
  if (!goal) return null;

  const DIRS = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
  ];

  // State key matches canReachGoal's formula so the two are consistent.
  const stateKey = (x, y, ws) => ws * width * (height + 1) + (y + 1) * width + x;

  // Map from stateKey → { move, parentKey } for path reconstruction.
  const parents = new Map();
  const startKey = stateKey(startPos.x, startPos.y, worldState);
  parents.set(startKey, { move: null, parentKey: null });

  const queue = [{ x: startPos.x, y: startPos.y, ws: worldState, key: startKey }];
  let head = 0;

  while (head < queue.length) {
    const { x, y, ws, key } = queue[head++];

    if (x === goal.x && y === goal.y) {
      const path = [];
      let cur = parents.get(key);
      while (cur.move !== null) {
        path.unshift(cur.move);
        cur = parents.get(cur.parentKey);
      }
      return path;
    }

    for (const { dx, dy } of DIRS) {
      const r = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws);
      let nws = ws;
      if (r.crumble?.toggleIdx      !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);

      // Skip no-op moves (position unchanged, world unchanged).
      if (r.x === x && r.y === y && nws === ws) continue;

      const k = stateKey(r.x, r.y, nws);
      if (!parents.has(k)) {
        parents.set(k, { move: { dx, dy }, parentKey: key });
        queue.push({ x: r.x, y: r.y, ws: nws, key: k });
      }
    }
  }

  return null;
}
