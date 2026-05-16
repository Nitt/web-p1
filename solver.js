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

// State key: x (4b) | y (4b) | ws (8b) | prevDir (3b) | gearsLeft (5b) = 24 bits.
function _key(x, y, ws, prevDir, gearsLeft) {
  return x | (y << 4) | (ws << 8) | (prevDir << 16) | (gearsLeft << 19);
}

// ── Solver ───────────────────────────────────────────────────────────────────

/**
 * Dijkstra — finds the move sequence with minimum physical chain length.
 *
 * Models prevDir and gearsLeft so gear consumption is tracked accurately:
 * a direction change from prevDir costs one gear and branches that exceed the
 * gear budget are pruned.  Teleporter moves use the physical chain extension
 * (entry→player + exit→target) rather than straight-line Manhattan distance.
 *
 * @param {object}        level
 * @param {{x,y}}         startPos        – player position after initial auto-slide
 * @param {number}        worldState      – world-state bitmask at startPos
 * @param {Map}           toggleMap
 * @param {number}        chainLengthTotal – chain budget (0 → unconstrained)
 * @param {number}        [gearsTotal]     – gear budget; omit/null for generous default (20)
 * @param {{dx,dy}|null}  [startPrevDir]   – prevDir after initial slide; null = no direction yet
 * @returns {{dx,dy}[]|null}
 */
export function solve(level, startPos, worldState, toggleMap, chainLengthTotal,
                      gearsTotal, startPrevDir) {
  const { width, height, goal } = level;
  if (!goal) return null;

  const chainLimit = chainLengthTotal > 0 ? chainLengthTotal : (width + height) * 4;
  const gearsInit  = (gearsTotal != null && gearsTotal >= 0) ? Math.min(gearsTotal, 31) : 20;
  const initDir    = startPrevDir ? _dirIdx(startPrevDir.dx, startPrevDir.dy) : NO_DIR;

  const dist    = new Map();
  const parents = new Map();

  const k0 = _key(startPos.x, startPos.y, worldState, initDir, gearsInit);
  dist.set(k0, 0);
  parents.set(k0, { move: null, parentKey: null });

  // Heap entries: [cost, x, y, ws, prevDir, gearsLeft, key]
  const heap = new MinHeap();
  heap.push([0, startPos.x, startPos.y, worldState, initDir, gearsInit, k0]);

  while (heap.size > 0) {
    const [cost, x, y, ws, prevDir, gearsLeft, key] = heap.pop();

    if (cost > (dist.get(key) ?? Infinity)) continue; // stale entry

    if (x === goal.x && y === goal.y) {
      const path = [];
      let cur = parents.get(key);
      while (cur.move !== null) { path.unshift(cur.move); cur = parents.get(cur.parentKey); }
      return path;
    }

    // Chain budget remaining — mirrors _executeMove's chainAvail calculation.
    const chainAvail = Math.max(0, chainLimit - cost);

    for (const { dx, dy } of DIRS) {
      const r = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws, null, chainAvail);

      let nws = ws;
      if (r.crumble?.toggleIdx      !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);

      if (r.x === x && r.y === y && nws === ws) continue; // no-op

      // Physical chain extension: for teleporter moves, the chain routes through
      // entry and exit — straight Manhattan from start to end over-/under-estimates.
      const slideLen = r.teleportCrossing
        ? Math.abs(r.teleportCrossing.entryX - x) + Math.abs(r.teleportCrossing.entryY - y)
          + Math.abs(r.x - r.teleportCrossing.exitX) + Math.abs(r.y - r.teleportCrossing.exitY)
        : Math.abs(r.x - x) + Math.abs(r.y - y);

      // A direction change from prevDir costs one gear (placed at departure position).
      // Teleport crossings travel in the same direction — never a bend by themselves.
      const newDirIdx    = _dirIdx(dx, dy);
      const isBend       = prevDir !== NO_DIR && newDirIdx !== prevDir;
      const newGearsLeft = isBend ? gearsLeft - 1 : gearsLeft;
      if (newGearsLeft < 0) continue; // gear budget exhausted — prune this branch

      const newCost = cost + slideLen;
      const nk      = _key(r.x, r.y, nws, newDirIdx, newGearsLeft);

      if (newCost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, newCost);
        parents.set(nk, { move: { dx, dy }, parentKey: key });
        heap.push([newCost, r.x, r.y, nws, newDirIdx, newGearsLeft, nk]);
      }
    }
  }

  return null;
}
