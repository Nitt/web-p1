import { slidePlayer } from './puzzle.js';

// ── Min-heap keyed on [cost, gearsUsed] ──────────────────────────────────────
// Primary sort: cost (chain length). Secondary: gearsUsed (fewer gears preferred
// on equal-cost ties so the solver always returns the minimum-gear solution among
// all minimum-chain solutions).

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
  _less(i, j) {
    const a = this._h[i], b = this._h[j];
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this._less(i, p)) break;
      [this._h[p], this._h[i]] = [this._h[i], this._h[p]];
      i = p;
    }
  }
  _down(i) {
    const n = this._h.length;
    while (true) {
      let m = i, l = 2*i+1, r = 2*i+2;
      if (l < n && this._less(l, m)) m = l;
      if (r < n && this._less(r, m)) m = r;
      if (m === i) break;
      [this._h[m], this._h[i]] = [this._h[i], this._h[m]];
      i = m;
    }
  }
}

// ── Direction encoding ───────────────────────────────────────────────────────

const DIRS = [
  { dx: 1, dy: 0 },   // 0 right
  { dx: -1, dy: 0 },  // 1 left
  { dx: 0, dy: 1 },   // 2 down
  { dx: 0, dy: -1 },  // 3 up
];
const NO_DIR = 4; // no previous direction (start of level)

function _dirIdx(dx, dy) {
  if (dx > 0) return 0;
  if (dx < 0) return 1;
  return dy > 0 ? 2 : 3;
}

// State key: x (4b) | y (4b) | ws (8b) | prevDir (3b) | gearsUsed (5b) = 24 bits.
// gearsUsed counts UP from 0 so the state is independent of the initial budget —
// both the generator simulation and the game's live solver start at gearsUsed=0
// and explore identical states, guaranteeing they find the same optimal path.
function _key(x, y, ws, prevDir, gearsUsed) {
  return x | (y << 4) | (ws << 8) | (prevDir << 16) | (gearsUsed << 19);
}

// ── Solver ───────────────────────────────────────────────────────────────────

/**
 * Dijkstra — finds the minimum physical-chain-length path to the goal.
 *
 * Among paths with equal chain length, prefers the one using the fewest gear
 * changes (direction bends).  Prunes any branch that would exceed maxGears.
 *
 * Because the state encodes gearsUsed (counting up from 0) rather than
 * gearsLeft (counting down from budget), the generator simulation and the
 * game's live solver share the same state space and always find the same
 * optimal path regardless of their starting budgets.
 *
 * @param {object}        level
 * @param {{x,y}}         startPos        – player position after initial auto-slide
 * @param {number}        worldState      – world-state bitmask at startPos
 * @param {Map}           toggleMap
 * @param {number}        chainLengthTotal – chain budget (0 → unconstrained)
 * @param {number}        [maxGears]       – max gear changes allowed; null/undefined → 20
 * @param {{dx,dy}|null}  [startPrevDir]   – prevDir after initial slide; null = no direction yet
 * @returns {{dx,dy}[]|null}
 */
export function solve(level, startPos, worldState, toggleMap, chainLengthTotal,
                      maxGears, startPrevDir) {
  const { width, height, goal } = level;
  if (!goal) return null;

  const chainLimit = chainLengthTotal > 0 ? chainLengthTotal : (width + height) * 4;
  const gearsMax   = (maxGears != null && maxGears >= 0) ? Math.min(maxGears, 31) : 20;
  const initDir    = startPrevDir ? _dirIdx(startPrevDir.dx, startPrevDir.dy) : NO_DIR;

  const dist    = new Map();
  const parents = new Map();

  const k0 = _key(startPos.x, startPos.y, worldState, initDir, 0);
  dist.set(k0, 0);
  parents.set(k0, { move: null, parentKey: null });

  // Heap entries: [cost, gearsUsed, x, y, ws, prevDirIdx, key]
  const heap = new MinHeap();
  heap.push([0, 0, startPos.x, startPos.y, worldState, initDir, k0]);

  while (heap.size > 0) {
    const [cost, gearsUsed, x, y, ws, prevDir, key] = heap.pop();

    if (cost > (dist.get(key) ?? Infinity)) continue; // stale entry

    if (x === goal.x && y === goal.y) {
      const path = [];
      let cur = parents.get(key);
      while (cur.move !== null) { path.unshift(cur.move); cur = parents.get(cur.parentKey); }
      return path;
    }

    for (const { dx, dy } of DIRS) {
      // Always slide to the natural stop (wall/sticky/one-way).  Budget enforcement
      // is done by pruning below, not by capping individual slides.  Capping would
      // make the solver plan paths with mid-slide stops that the game never produces,
      // causing the generator and live solver to explore different state spaces and
      // find different paths.
      const r = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws, null, chainLimit);

      let nws = ws;
      if (r.crumble?.toggleIdx      !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);
      if (r.x === x && r.y === y && nws === ws) continue; // no-op

      // Physical chain extension: for teleporter moves the chain routes through entry
      // and exit — straight Manhattan from start to end over-/under-estimates.
      const slideLen = r.teleportCrossing
        ? Math.abs(r.teleportCrossing.entryX - x) + Math.abs(r.teleportCrossing.entryY - y)
          + Math.abs(r.x - r.teleportCrossing.exitX) + Math.abs(r.y - r.teleportCrossing.exitY)
        : Math.abs(r.x - x) + Math.abs(r.y - y);

      const newCost = cost + slideLen;
      if (newCost > chainLimit) continue; // prune: exceeds chain budget

      // A direction change from prevDir costs one gear (placed at departure position).
      // Teleport crossings travel in the same direction — never a bend by themselves.
      const newDirIdx    = _dirIdx(dx, dy);
      const isBend       = prevDir !== NO_DIR && newDirIdx !== prevDir;
      const newGearsUsed = isBend ? gearsUsed + 1 : gearsUsed;
      if (newGearsUsed > gearsMax) continue; // gear budget exhausted — prune this branch
      const nk      = _key(r.x, r.y, nws, newDirIdx, newGearsUsed);

      if (newCost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, newCost);
        parents.set(nk, { move: { dx, dy }, parentKey: key });
        heap.push([newCost, newGearsUsed, r.x, r.y, nws, newDirIdx, nk]);
      }
    }
  }

  return null;
}
