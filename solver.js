import { slidePlayer } from './puzzle.js';

// ── Min-heap keyed on cost[0] ────────────────────────────────────────────────

class MinHeap {
  constructor() { this._h = []; }
  get size() { return this._h.length; }
  push(item) { this._h.push(item); this._up(this._h.length - 1); }
  pop() {
    const top = this._h[0];
    const last = this._h.pop();
    if (this._h.length > 0) { this._h[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._h[p][0] <= this._h[i][0]) break;
      [this._h[p], this._h[i]] = [this._h[i], this._h[p]];
      i = p;
    }
  }
  _down(i) {
    const n = this._h.length;
    while (true) {
      let m = i, l = 2*i+1, r = 2*i+2;
      if (l < n && this._h[l][0] < this._h[m][0]) m = l;
      if (r < n && this._h[r][0] < this._h[m][0]) m = r;
      if (m === i) break;
      [this._h[m], this._h[i]] = [this._h[i], this._h[m]];
      i = m;
    }
  }
}

// ── Solver ───────────────────────────────────────────────────────────────────

/**
 * Dijkstra pathfinder — returns the move sequence with minimum total cells
 * traveled (chain length), which matches the game's chain length budget.
 *
 * Each move is simulated with the remaining chain budget as the slide cap,
 * mirroring how _executeMove applies chainAvail in game.js.
 *
 * @param {object} level           - current level object
 * @param {{x,y}} startPos         - current player position
 * @param {number} worldState      - current world state bitmask
 * @param {Map<number,number>} toggleMap
 * @param {number} chainLengthTotal - from state.chainLengthTotal
 * @returns {{dx:number,dy:number}[]|null} move sequence, or null if unsolvable
 */
export function solve(level, startPos, worldState, toggleMap, chainLengthTotal) {
  const { width, height, goal } = level;
  if (!goal) return null;

  const chainLimit = chainLengthTotal > 0 ? chainLengthTotal : (width + height);

  const DIRS = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
  ];

  // State key: same formula as canReachGoal for consistency.
  const stateKey = (x, y, ws) => ws * width * (height + 1) + (y + 1) * width + x;

  const dist    = new Map(); // stateKey -> minimum cells-traveled cost
  const parents = new Map(); // stateKey -> { move, parentKey }

  const startKey = stateKey(startPos.x, startPos.y, worldState);
  dist.set(startKey, 0);
  parents.set(startKey, { move: null, parentKey: null });

  // Heap entries: [cost, x, y, ws, key]
  const heap = new MinHeap();
  heap.push([0, startPos.x, startPos.y, worldState, startKey]);

  while (heap.size > 0) {
    const [cost, x, y, ws, key] = heap.pop();

    if (cost > (dist.get(key) ?? Infinity)) continue; // stale entry

    if (x === goal.x && y === goal.y) {
      const path = [];
      let cur = parents.get(key);
      while (cur.move !== null) {
        path.unshift(cur.move);
        cur = parents.get(cur.parentKey);
      }
      return path;
    }

    // Remaining chain budget — mirrors _executeMove's chainAvail calculation.
    const chainAvail = Math.max(0, chainLimit - cost);

    for (const { dx, dy } of DIRS) {
      // Simulate the slide with the same chain cap the game would apply.
      const r = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws, null, chainAvail);
      let nws = ws;
      if (r.crumble?.toggleIdx      !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);

      // Skip no-op moves (no position change, no world change).
      if (r.x === x && r.y === y && nws === ws) continue;

      const slideLen = Math.abs(r.x - x) + Math.abs(r.y - y);
      const newCost  = cost + slideLen;
      const k        = stateKey(r.x, r.y, nws);

      if (newCost < (dist.get(k) ?? Infinity)) {
        dist.set(k, newCost);
        parents.set(k, { move: { dx, dy }, parentKey: key });
        heap.push([newCost, r.x, r.y, nws, k]);
      }
    }
  }

  return null;
}
