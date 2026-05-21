import { slidePath } from './generator.js';
import { buildToggleMap, onewayAllows } from './puzzle.js';

// Returns the one-way cell type at (pos.x+dx, pos.y+dy), or 0 if none.
function _adjacentOnewayCell(cells, width, height, pos, dx, dy) {
  const nx = pos.x + dx, ny = pos.y + dy;
  if (nx < 0 || nx >= width || ny < 0 || ny >= height) return 0;
  const cell = cells[ny * width + nx];
  return (cell >= 3 && cell <= 6) ? cell : 0;
}

// Extract {x,y} from a stateKey string without splitting the whole key.
function _posFromKey(k) {
  const c1 = k.indexOf(',');
  const c2 = k.indexOf(',', c1 + 1);
  return { x: +k.slice(0, c1), y: +k.slice(c1 + 1, c2) };
}

// Direction table — index 0–3 matches generator.js DIRS4 ordering.
const DIRS4 = [
  { dx:  1, dy:  0 },  // 0 RIGHT
  { dx: -1, dy:  0 },  // 1 LEFT
  { dx:  0, dy:  1 },  // 2 DOWN
  { dx:  0, dy: -1 },  // 3 UP
];
// di=4 means "no prior direction" (start of level or boat).

/**
 * Find the optimal move sequence from the given game state to level.goal.
 *
 * Optimality: minimum gears (bends) first, minimum chain (cells traveled) as tiebreaker.
 *
 * @param {object} level        - level object (cells, width, height, goal, …)
 * @param {object} startPos     - {x, y} — current player position (may be boat y=-1)
 * @param {number} worldState   - current toggle bitmask
 * @param {number} gearsLeft    - remaining gear budget
 * @param {number} chainAvail   - remaining chain budget (chainLengthTotal - _chainLengthUsed())
 * @param {number} prevDi       - direction index of last move (0–3), or 4 for none
 * @returns {{ moves: {dx,dy}[], chainUsed: number, gearsUsed: number } | null}
 */
export function solve(level, startPos, worldState, gearsLeft, chainAvail, prevDi = 4) {
  const { cells, width, height, goal, doorRequirements = null, teleporterMap = null } = level;
  const toggleMap = buildToggleMap(cells);

  const stateKey = (x, y, di, ws, g) => `${x},${y},${di},${ws},${g}`;

  const heap   = [];
  const best   = new Map(); // stateKey → minimum [g, chain] seen
  const parent = new Map(); // stateKey → { fromKey, di, x, y } for path reconstruction

  function heapPush(e) {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (_cmp(heap[p], heap[i]) <= 0) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }
  function heapPop() {
    const top  = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let s = i, l = 2*i+1, r = 2*i+2;
        if (l < heap.length && _cmp(heap[l], heap[s]) < 0) s = l;
        if (r < heap.length && _cmp(heap[r], heap[s]) < 0) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  }
  function _cmp(a, b) {
    if (a.g !== b.g) return a.g - b.g;
    return a.chain - b.chain;
  }

  function isBetter(sk, g, chain) {
    const cur = best.get(sk);
    if (!cur) return true;
    return g < cur[0] || (g === cur[0] && chain < cur[1]);
  }

  const startKey = stateKey(startPos.x, startPos.y, prevDi, worldState, 0);
  best.set(startKey, [0, 0]);
  parent.set(startKey, null);
  heapPush({ x: startPos.x, y: startPos.y, di: prevDi, ws: worldState, g: 0, chain: 0, key: startKey });

  let goalKey = null;

  outer: while (heap.length > 0) {
    const cur = heapPop();
    const { x, y, di, ws, g, chain, key } = cur;

    const settled = best.get(key);
    if (!settled || g > settled[0] || (g === settled[0] && chain > settled[1])) continue;

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];

      if (y < 0 && dy !== 1) continue;

      const isReversal = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;
      const isBend     = di < 4 && i !== di && !isReversal;
      const newG       = g + (isBend ? 1 : 0);
      if (newG > gearsLeft) continue;

      const { path, crumblePos, keyPos } =
        slidePath(cells, width, height, { x, y }, dx, dy, toggleMap, ws, doorRequirements, teleporterMap);

      const adjOW = _adjacentOnewayCell(cells, width, height, { x, y }, dx, dy);
      const blockedByOneway = path.length === 0 && crumblePos === null
        && adjOW !== 0 && !onewayAllows(adjOW, dx, dy);
      // Backtrack: adjacent one-way blocks this direction but allows the opposite,
      // meaning the chain crossed it in (-dx,-dy). No reversal requirement —
      // the player can press the same direction twice to trigger it.
      const isChainBacktrack = blockedByOneway && onewayAllows(adjOW, -dx, -dy);

      const avail      = chainAvail - chain;
      const cappedPath = path.length <= avail ? path : path.slice(0, avail);

      if (cappedPath.length === 0 && !crumblePos && !isChainBacktrack) continue;

      // ── Forward landing ──────────────────────────────────────────────────────
      if (cappedPath.length > 0) {
        const landing  = cappedPath[cappedPath.length - 1];
        const newChain = chain + cappedPath.length;
        const keyApplies = keyPos !== null && cappedPath.length === path.length;
        const ews        = keyApplies ? (ws | (1 << keyPos.toggleIdx)) : ws;
        const nk         = stateKey(landing.x, landing.y, i, ews, newG);

        if (isBetter(nk, newG, newChain)) {
          best.set(nk, [newG, newChain]);
          parent.set(nk, { fromKey: key, di: i, x: landing.x, y: landing.y });
          heapPush({ x: landing.x, y: landing.y, di: i, ws: ews, g: newG, chain: newChain, key: nk });

          if (landing.x === goal.x && landing.y === goal.y) {
            goalKey = nk;
            break outer;
          }
        }
      }

      // ── Crumble bounce (worldState change, player stays) ────────────────────
      if (crumblePos && crumblePos.toggleIdx !== undefined && cappedPath.length === path.length) {
        const newWS        = ws | (1 << crumblePos.toggleIdx);
        const from         = cappedPath.length > 0 ? cappedPath[cappedPath.length - 1] : { x, y };
        const crumbleG     = cappedPath.length === 0 ? g  : newG;
        const crumbleDi    = cappedPath.length === 0 ? di : i;
        const crumbleChain = chain + cappedPath.length;
        const nk = stateKey(from.x, from.y, crumbleDi, newWS, crumbleG);

        if (isBetter(nk, crumbleG, crumbleChain)) {
          best.set(nk, [crumbleG, crumbleChain]);
          parent.set(nk, { fromKey: key, di: crumbleDi, x: from.x, y: from.y });
          heapPush({ x: from.x, y: from.y, di: crumbleDi, ws: newWS, g: crumbleG, chain: crumbleChain, key: nk });
        }
      }

      // ── One-way backtrack ─────────────────────────────────────────────────────
      // Walk the parent chain to find the first ancestor on the entry side of the
      // one-way (the side the chain came from), then snap the player back there.
      if (isChainBacktrack) {
        const owx = x + dx, owy = y + dy;
        let walkKey = key;
        let ancKey = null, ancX, ancY;
        while (true) {
          const pe = parent.get(walkKey);
          const wp = pe !== null ? { x: pe.x, y: pe.y } : _posFromKey(walkKey);
          // Entry side: (wp - OW) · (dx, dy) > 0
          if ((wp.x - owx) * dx + (wp.y - owy) * dy > 0) {
            ancKey = walkKey; ancX = wp.x; ancY = wp.y;
            break;
          }
          if (pe === null) break;
          walkKey = pe.fromKey;
        }
        if (ancKey !== null) {
          const ancBest = best.get(ancKey);
          if (ancBest) {
            const [ancG, ancChain] = ancBest;
            const bnk = stateKey(ancX, ancY, i, ws, ancG);
            if (isBetter(bnk, ancG, ancChain)) {
              best.set(bnk, [ancG, ancChain]);
              parent.set(bnk, { fromKey: key, di: i, x: ancX, y: ancY });
              heapPush({ x: ancX, y: ancY, di: i, ws, g: ancG, chain: ancChain, key: bnk });
              if (ancX === goal.x && ancY === goal.y) { goalKey = bnk; break outer; }
            }
          }
        }
      }
    }
  }

  if (goalKey === null) {
    console.warn('[solver] no path found — dead end or solver cannot model required backtracking');
    return null;
  }

  // Reconstruct move sequence by walking parent pointers.
  const diSeq = [];
  let cur = goalKey;
  while (true) {
    const entry = parent.get(cur);
    if (entry === null) break;
    diSeq.push(entry.di);
    cur = entry.fromKey;
  }
  diSeq.reverse();

  const moves = diSeq.map(di => ({ dx: DIRS4[di].dx, dy: DIRS4[di].dy }));

  const goalBest = best.get(goalKey);
  return { moves, chainUsed: goalBest[1], gearsUsed: goalBest[0] };
}
