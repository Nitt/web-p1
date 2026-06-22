import { slidePlayer, buildToggleMap } from './puzzle.js';


// Direction table — index 0–3 matches generator.js DIRS4 ordering.
const DIRS4 = [
  { dx:  1, dy:  0 },  // 0 RIGHT
  { dx: -1, dy:  0 },  // 1 LEFT
  { dx:  0, dy:  1 },  // 2 DOWN
  { dx:  0, dy: -1 },  // 3 UP
];
// di=4 means "no prior direction" (start of level or boat).
const OPPOSITE_DI = [1, 0, 3, 2]; // RIGHT↔LEFT, DOWN↔UP


// Returns true if the immediately adjacent cell in direction di is an intact CRUMBLE.
// Crumble bounces cost 0 gears (no movement), so they share b=0 priority with straights.
function adjacentCrumble(x, y, di, cells, width, height, toggleMap, ws) {
  const nx = x + DIRS4[di].dx;
  const ny = y + DIRS4[di].dy;
  if (nx < 0 || nx >= width || ny < 0 || ny >= height) return false;
  if (cells[ny * width + nx] !== 7 /* CellType.CRUMBLE */) return false;
  const tIdx = toggleMap.get(ny * width + nx);
  return tIdx !== undefined && !(ws & (1 << tIdx));
}


/**
 * Find the optimal move sequence from the given game state to level.goal.
 *
 * Optimality: minimum gears (bends).
 *
 * State key: (x, y, incomingDir, worldState) — gear cost is NOT part of the
 * key so Dijkstra pruning works correctly.
 *
 * Each state spawns one heap entry per valid outgoing direction (up to 3),
 * so the heap always has all pending moves pre-priced.  Priority = g*2 + b,
 * where b=0 for straight continuations and crumble bounces (free), b=1 for
 * real bends.  This guarantees free interactions are explored before any
 * gear-costing move at the same gear level.
 *
 * Gear is charged only on actual movement: crumble bounces (no movement)
 * never consume a gear even if the direction is a bend.
 *
 * Reversals are skipped — the game stops the player at gear waypoints during
 * a reversal, not at natural walls, so we cannot accurately model reversal
 * landings.  Virtual one-way landings are synthesised instead.
 *
 * @param {object} level        - level object (cells, width, height, goal, …)
 * @param {object} startPos     - {x, y} — current player position (may be boat y=-1)
 * @param {number} worldState   - current toggle bitmask
 * @param {number} gearsLeft    - remaining gear budget
 * @param {number} prevDi       - direction index of last move (0–3), or 4 for none
 * @returns {{ moves: {dx,dy}[], gearsUsed: number } | null}
 */
export function solve(level, startPos, worldState, gearsLeft, prevDi = 4) {
  const { cells, width, height, goal } = level;
  const toggleMap = buildToggleMap(cells);

  if (startPos.x === goal.x && startPos.y === goal.y) {
    return { moves: [], gearsUsed: 0 };
  }

  const stateKey = (x, y, di, ws) => `${x},${y},${di},${ws}`;

  const heap   = [];
  const best   = new Map(); // stateKey → minimum gears seen at this state
  const parent = new Map(); // stateKey → { fromKey, di, virtualLanding? } | null

  // Priority: g*2 + b.  Within the same expected-cost bucket, free interactions (b=0)
  // are explored before real bends (b=1).
  const pri = e => e.g * 2 + e.b;

  function heapPush(e) {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pri(heap[p]) <= pri(heap[i])) break;
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
        if (l < heap.length && pri(heap[l]) < pri(heap[s])) s = l;
        if (r < heap.length && pri(heap[r]) < pri(heap[s])) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  }

  // Push one heap entry per valid outgoing direction from (x,y) in worldState ws.
  // incoming = direction of the last actual slide (or prevDi at start).
  // Bend directions that lead to an adjacent intact crumble get b=0 (free bounce).
  // Hook cells (CellType.HOOK = 11) act as permanent free anchors — bends cost 0.
  function pushOutgoing(x, y, incoming, ws, g, key) {
    const onHook = y >= 0 && cells[y * width + x] === 11 /* CellType.HOOK */;
    for (let d = 0; d < 4; d++) {
      if (incoming < 4 && d === OPPOSITE_DI[incoming]) continue; // reversal
      if (y < 0 && DIRS4[d].dy !== 1) continue;                  // boat: only DOWN
      const isBend = incoming < 4 && d !== incoming;
      const b = (isBend && !onHook && !adjacentCrumble(x, y, d, cells, width, height, toggleMap, ws)) ? 1 : 0;
      heapPush({ x, y, di: incoming, outgoing: d, ws, g, b, key });
    }
  }

  const startKey = stateKey(startPos.x, startPos.y, prevDi, worldState);
  best.set(startKey, 0);
  parent.set(startKey, null);
  pushOutgoing(startPos.x, startPos.y, prevDi, worldState, 0, startKey);

  let goalKey = null;
  let finalDi  = -1;
  let finalG   = 0;

  while (heap.length > 0) {
    const { x, y, di: incoming, outgoing, ws, g, b, key } = heapPop();

    // Lazy-deletion staleness check.
    if ((best.get(key) ?? Infinity) < g) continue;

    const { dx, dy } = DIRS4[outgoing];
    if (y < 0 && dy !== 1) continue; // boat safety

    const result = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws);
    const moved  = result.x !== x || result.y !== y;

    // ── Crumble bounce: no movement, new universe ─────────────────────────────
    // No gear is charged.  prevDir is restored to incoming by the game, so gear
    // costs for subsequent moves continue to be computed against incoming.
    if (!moved && result.crumble) {
      const crumbleWS = ws | (1 << result.crumble.toggleIdx);
      const nk = stateKey(x, y, incoming, crumbleWS);
      if ((best.get(nk) ?? Infinity) > g) {
        best.set(nk, g);
        parent.set(nk, { fromKey: key, di: outgoing });
        pushOutgoing(x, y, incoming, crumbleWS, g, nk);
      }
      continue;
    }

    if (!moved) continue;

    // ── Player moved ──────────────────────────────────────────────────────────
    // Gear is charged here (b=1 → bend → costs 1 gear; b=0 → free).
    const actualG = g + b;
    if (actualG > gearsLeft) continue;

    const lx = result.x, ly = result.y;

    const finalWS = result.crumble
      ? ws | (1 << result.crumble.toggleIdx)
      : ws;

    // ── Goal ──────────────────────────────────────────────────────────────────
    if (lx === goal.x && ly === goal.y) {
      goalKey = key;
      finalDi = outgoing;
      finalG  = actualG;
      break;
    }

    // ── Forward landing ───────────────────────────────────────────────────────
    const nk = stateKey(lx, ly, outgoing, finalWS);
    if ((best.get(nk) ?? Infinity) > actualG) {
      best.set(nk, actualG);
      parent.set(nk, { fromKey: key, di: outgoing });
      pushOutgoing(lx, ly, outgoing, finalWS, actualG, nk);
    }

    // ── Virtual one-way landing ───────────────────────────────────────────────
    // The cell just after the last traversable one-way in the slide can be
    // reached by: slide forward to the actual landing (firing any crumble/key),
    // then reverse.  Uses finalWS because the forward slide already activated
    // any crumble or key before the backtrack happens.
    //
    // After the two-move sequence [forward, back], the player's prevDir is the
    // backtrack direction (OPPOSITE_DI[outgoing]), NOT the forward direction.
    // Using outgoing as incoming was wrong: it allowed the forward direction as
    // a free straight and blocked the backtrack as a reversal — exactly backwards.
    const vPos = result.virtualLanding;
    if (vPos) {
      const vIncoming = OPPOSITE_DI[outgoing];
      const vNk = stateKey(vPos.x, vPos.y, vIncoming, finalWS);
      if ((best.get(vNk) ?? Infinity) > actualG) {
        best.set(vNk, actualG);
        parent.set(vNk, { fromKey: key, di: outgoing, virtualLanding: true });
        pushOutgoing(vPos.x, vPos.y, vIncoming, finalWS, actualG, vNk);
      }
    }
  }

  if (goalKey === null) return null;

  // ── Reconstruct move sequence ─────────────────────────────────────────────
  // goalKey is the state we were processing when the goal was reached.
  // finalDi is the outgoing direction of that last slide.
  // Walk parent pointers backward, then reverse.
  const diSeq = [finalDi];
  let cur = goalKey;
  while (true) {
    const entry = parent.get(cur);
    if (entry === null) break;
    if (entry.virtualLanding) diSeq.push(OPPOSITE_DI[entry.di]);
    diSeq.push(entry.di);
    cur = entry.fromKey;
  }
  diSeq.reverse();

  const moves = diSeq.map(d => ({ dx: DIRS4[d].dx, dy: DIRS4[d].dy }));
  return { moves, gearsUsed: finalG };
}
