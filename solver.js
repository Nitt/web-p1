import { slidePath } from './generator.js';
import { buildToggleMap } from './puzzle.js';

// Returns true if the cell at (pos.x+dx, pos.y+dy) is a one-way that blocks
// movement in direction (dx,dy). Mirrors _onewayAllows in generator.js.
function _adjacentBlockedByOneway(cells, width, height, pos, dx, dy) {
  const nx = pos.x + dx, ny = pos.y + dy;
  if (nx < 0 || nx >= width || ny < 0 || ny >= height) return false;
  const cell = cells[ny * width + nx];
  if (cell < 3 || cell > 6) return false;
  // ONEWAY_LEFT=3(dx=-1), ONEWAY_RIGHT=4(dx=1), ONEWAY_UP=5(dy=-1), ONEWAY_DOWN=6(dy=1)
  switch (cell) {
    case 3: return !(dx === -1 && dy === 0);
    case 4: return !(dx ===  1 && dy === 0);
    case 5: return !(dx ===  0 && dy === -1);
    case 6: return !(dx ===  0 && dy ===  1);
    default: return false;
  }
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

  // State key: encodes (x, y, di, ws, gearsUsed) into a single number.
  // gearsLeft budget is at most ~20 in practice; ws fits in a few bits.
  // We use a Map with a string key for simplicity and correctness.
  const stateKey = (x, y, di, ws, g) =>
    `${x},${y},${di},${ws},${g}`;

  // Heap entries: { x, y, di, ws, g, chain, fromKey }
  // Priority: gears first (g), chain second.
  const heap  = [];
  const best  = new Map(); // stateKey → minimum [g, chain] seen
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

    // Skip stale heap entries (a better path to this state was recorded later).
    const settled = best.get(key);
    if (!settled || g > settled[0] || (g === settled[0] && chain > settled[1])) continue;

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];

      // From boat (y < 0), only allow diving down.
      if (y < 0 && dy !== 1) continue;

      const isReversal = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;
      const isBend     = di < 4 && i !== di && !isReversal;
      const newG       = g + (isBend ? 1 : 0);
      if (newG > gearsLeft) continue;

      const { path, crumblePos, keyPos } =
        slidePath(cells, width, height, { x, y }, dx, dy, toggleMap, ws, doorRequirements, teleporterMap);

      const blockedByOneway = path.length === 0 && crumblePos === null
        && _adjacentBlockedByOneway(cells, width, height, { x, y }, dx, dy);
      const chainRetracts = isReversal && blockedByOneway;

      // Cap forward moves at available chain budget.
      const avail      = chainAvail - chain;
      const cappedPath = chainRetracts ? path : (path.length <= avail ? path : path.slice(0, avail));

      if (cappedPath.length === 0 && !crumblePos && !(isReversal && blockedByOneway)) continue;

      // ── Forward landing ──────────────────────────────────────────────────────
      if (cappedPath.length > 0) {
        const landing  = cappedPath[cappedPath.length - 1];
        const newChain = chainRetracts
          ? chain - cappedPath.length
          : chain + cappedPath.length;
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

      // ── Post-oneway exit node ────────────────────────────────────────────────
      // When a slide passes through one or more one-way tiles, also explore from
      // the cell immediately after the LAST one-way encountered (not the final
      // landing). That position is where the player can stand and trigger a
      // one-way backtrack on a later move, so the solver must consider paths
      // that branch from there. Mirrors the generator's Pass 1 logic.
      if (!chainRetracts && cappedPath.length > 1) {
        let lastOWIdx = -1;
        for (let j = 0; j < cappedPath.length - 1; j++) {
          if (cappedPath[j].cell >= 3 && cappedPath[j].cell <= 6) lastOWIdx = j;
        }
        if (lastOWIdx >= 0 && lastOWIdx + 1 < cappedPath.length - 1) {
          const exitCell  = cappedPath[lastOWIdx + 1];
          const exitChain = chain + lastOWIdx + 2; // cells traveled to reach exit
          const ownk      = stateKey(exitCell.x, exitCell.y, i, ws, newG);
          if (isBetter(ownk, newG, exitChain)) {
            best.set(ownk, [newG, exitChain]);
            parent.set(ownk, { fromKey: key, di: i, x: exitCell.x, y: exitCell.y });
            heapPush({ x: exitCell.x, y: exitCell.y, di: i, ws, g: newG, chain: exitChain, key: ownk });
            if (exitCell.x === goal.x && exitCell.y === goal.y) {
              goalKey = ownk;
              break outer;
            }
          }
        }
      }

      // ── Crumble bounce (worldState change, player stays) ────────────────────
      if (crumblePos && crumblePos.toggleIdx !== undefined && cappedPath.length === path.length) {
        const newWS       = ws | (1 << crumblePos.toggleIdx);
        const from        = cappedPath.length > 0 ? cappedPath[cappedPath.length - 1] : { x, y };
        const crumbleG    = cappedPath.length === 0 ? g  : newG;
        const crumbleDi   = cappedPath.length === 0 ? di : i;
        const crumbleChain = chainRetracts
          ? chain - cappedPath.length
          : chain + cappedPath.length;
        const nk = stateKey(from.x, from.y, crumbleDi, newWS, crumbleG);

        if (isBetter(nk, crumbleG, crumbleChain)) {
          best.set(nk, [crumbleG, crumbleChain]);
          parent.set(nk, { fromKey: key, di: crumbleDi, x: from.x, y: from.y });
          heapPush({ x: from.x, y: from.y, di: crumbleDi, ws: newWS, g: crumbleG, chain: crumbleChain, key: nk });
        }
      }

      // ── One-way backtrack: reversal blocked by oneway retracts chain ─────────
      if (isReversal && blockedByOneway && path.length === 0) {
        const parentEntry = parent.get(key);
        if (parentEntry?.fromKey != null) {
          const grandEntry = parent.get(parentEntry.fromKey);
          if (grandEntry) {
            const grandBest = best.get(parentEntry.fromKey);
            if (grandBest) {
              const [backG, backChain] = grandBest;
              const bx = grandEntry.x, by = grandEntry.y;
              const bnk = stateKey(bx, by, di, ws, backG);
              if (isBetter(bnk, backG, backChain)) {
                best.set(bnk, [backG, backChain]);
                parent.set(bnk, { fromKey: key, di, x: bx, y: by });
                heapPush({ x: bx, y: by, di, ws, g: backG, chain: backChain, key: bnk });
              }
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
    if (entry === null) break; // start node
    diSeq.push(entry.di);
    cur = entry.fromKey;
  }
  diSeq.reverse();

  const moves = diSeq.map(di => ({ dx: DIRS4[di].dx, dy: DIRS4[di].dy }));

  const goalBest = best.get(goalKey);
  return { moves, chainUsed: goalBest[1], gearsUsed: goalBest[0] };
}
