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


/**
 * Find the optimal move sequence from the given game state to level.goal.
 *
 * Optimality: minimum gears (bends).
 *
 * State key: (x, y, prevDirIndex, worldState) — gear cost is NOT part of
 * the key so Dijkstra pruning works correctly.
 *
 * Reversals are skipped: the game stops the player at gear waypoints during
 * a reversal, not at natural walls, so we cannot accurately model reversal
 * landings.  Virtual one-way landings (slide forward to wall, reverse to the
 * cell just past the last one-way) are synthesised without exploring actual
 * reversal moves.
 *
 * @param {object} level        - level object (cells, width, height, goal, …)
 * @param {object} startPos     - {x, y} — current player position (may be boat y=-1)
 * @param {number} worldState   - current toggle bitmask
 * @param {number} gearsLeft    - remaining gear budget
 * @param {number} prevDi       - direction index of last move (0–3), or 4 for none
 * @returns {{ moves: {dx,dy}[], gearsUsed: number } | null}
 */
export function solve(level, startPos, worldState, gearsLeft, prevDi = 4) {
  const { cells, width, height, goal, doorRequirements = null, teleporterMap = null } = level;
  const toggleMap = buildToggleMap(cells);

  // State key does NOT include gear cost — proper Dijkstra pruning.
  const stateKey = (x, y, di, ws) => `${x},${y},${di},${ws}`;

  const heap   = [];
  const best   = new Map(); // stateKey → minimum gears seen at this state
  const parent = new Map(); // stateKey → { fromKey, di, virtualLanding? } | null

  function heapPush(e) {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].g <= heap[i].g) break;
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
        if (l < heap.length && heap[l].g < heap[s].g) s = l;
        if (r < heap.length && heap[r].g < heap[s].g) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  }

  const startKey = stateKey(startPos.x, startPos.y, prevDi, worldState);
  best.set(startKey, 0);
  parent.set(startKey, null);
  heapPush({ x: startPos.x, y: startPos.y, di: prevDi, ws: worldState, g: 0, key: startKey });

  let goalKey = null;

  while (heap.length > 0) {
    const { x, y, di, ws, g, key } = heapPop();

    // Lazy-deletion staleness check: a cheaper path to this state was already found.
    if ((best.get(key) ?? Infinity) < g) continue;

    // Break on pop — guarantees optimality. All cheaper states are already processed.
    if (x === goal.x && y === goal.y) { goalKey = key; break; }

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];

      // From the boat: only allow sliding down into the grid.
      if (y < 0 && dy !== 1) continue;

      // Skip reversals: we cannot accurately predict where the player stops
      // (game stops at gear waypoints, not at natural walls).
      const isReversal = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;
      if (isReversal) continue;

      // Gear cost: each direction change (bend) from a known prior direction costs 1.
      const isBend = di < 4 && i !== di;
      const newG   = g + (isBend ? 1 : 0);

      const result = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws);

      const moved = result.x !== x || result.y !== y;

      // ── No-movement crumble bounce ──────────────────────────────────────────
      // Player tried direction i, hit an intact crumble immediately — no movement.
      // Crumble always activates on contact.  No gear is charged (no movement).
      // prevDir updates to the attempted direction i.
      if (!moved && result.crumble) {
        const crumbleWS = ws | (1 << result.crumble.toggleIdx);
        const nk = stateKey(x, y, i, crumbleWS);
        if ((best.get(nk) ?? Infinity) > g) {
          best.set(nk, g);
          parent.set(nk, { fromKey: key, di: i });
          heapPush({ x, y, di: i, ws: crumbleWS, g, key: nk });
        }
        continue;
      }

      // No movement and no crumble → wall immediately adjacent; skip.
      if (!moved) continue;

      // ── Player moved ────────────────────────────────────────────────────────
      if (newG > gearsLeft) continue;

      const lx = result.x, ly = result.y;

      // Build new world state: key collected (if any) + crumble activated (if any).
      // Crumble always activates when the player stops adjacent to it.
      const keyWS  = result.keyCollected
        ? ws | (1 << result.keyCollected.toggleIdx)
        : ws;
      const finalWS = result.crumble
        ? keyWS | (1 << result.crumble.toggleIdx)
        : keyWS;

      // ── Forward landing ─────────────────────────────────────────────────────
      const nk = stateKey(lx, ly, i, finalWS);
      if ((best.get(nk) ?? Infinity) > newG) {
        best.set(nk, newG);
        parent.set(nk, { fromKey: key, di: i });
        heapPush({ x: lx, y: ly, di: i, ws: finalWS, g: newG, key: nk });
      }

      // ── Virtual one-way landing ─────────────────────────────────────────────
      // The cell just after the last traversable one-way in the slide can be
      // reached by: slide forward to the wall, then reverse (free — no gear
      // because it's the same direction index, just opposite).  The reverse
      // stops at the exit-adjacent cell blocked by the one-way.
      //
      // World state for virtual landing uses ws (not finalWS) because the key
      // and crumble at the actual landing haven't been reached yet.
      const vPos = result.virtualLanding;
      if (vPos) {
        const vNk = stateKey(vPos.x, vPos.y, i, ws);
        if ((best.get(vNk) ?? Infinity) > newG) {
          best.set(vNk, newG);
          parent.set(vNk, { fromKey: key, di: i, virtualLanding: true });
          heapPush({ x: vPos.x, y: vPos.y, di: i, ws, g: newG, key: vNk });
        }
      }
    }
  }

  if (goalKey === null) return null;

  // ── Reconstruct move sequence by walking parent pointers ───────────────────
  // Virtual landings expand to two moves: the forward slide + a reverse that
  // stops at the exit-adjacent cell.  We walk backwards, so we push the reverse
  // first, then the forward — after reversing the array the order is correct.
  const diSeq = [];
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
  return { moves, gearsUsed: best.get(goalKey) };
}
