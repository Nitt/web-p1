import { makeRng } from './random.js';

// ── Internal generator cell values ──────────────────────────────────────────
const G = { UNTOUCHED: 0, EMPTY: 1, STICKY: 2, BLOCK: 3, ONEWAY: 4, CRUMBLE: 5 };

const DIRS = [
  { key: 'LEFT',  dx: -1, dy:  0 },
  { key: 'UP',    dx:  0, dy: -1 },
  { key: 'RIGHT', dx:  1, dy:  0 },
  { key: 'DOWN',  dx:  0, dy:  1 },
];

// Probability weights for choosing a cell type when carving into UNTOUCHED
const WEIGHTS = { sticky: 0.06, block: 0.10, oneway: 0.02, crumble: 0.07, empty: 1.00 };
const WEIGHT_TOTAL = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// Maps a ONEWAY direction key → the CellType value used in the output level
const ONEWAY_OUT = { LEFT: 3, RIGHT: 4, UP: 5, DOWN: 6 };

// ── Difficulty weights ────────────────────────────────────────────────────────
// Each entry represents the cognitive cost added to a move when that interaction
// occurs. BASE_MOVE is applied once per slide action. All others stack on top.
// Add new cell types here as they are introduced (crumbles, keys, doors, etc.).
export const DIFFICULTY_WEIGHTS = {
  BASE_MOVE:       1.0,   // every slide, regardless of length
  STICKY:          0.5,   // landing on a sticky cell (easy to predict, minor load)
  ONEWAY_TRAVERSE: 1.0,   // passing through a one-way in the allowed direction
  ONEWAY_BLOCKED:  2.5,   // stopped by a one-way approaching from the wrong direction
  CRUMBLE:         3.0,   // stopped by a crumble block (topology change, high load)
  KEY:             2.5,   // stopping to collect a key
  DOOR_TRAVERSE:   1.0,   // sliding through an already-open door
  DOOR_LOCKED:     3.5,   // stopped by a locked door (high load — player must find the key)
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a level using a randomised DFS carving algorithm.
 *
 * @param {number} width   - inner column count (no padding)
 * @param {number} height  - inner row count
 * @param {{ seed?: number, id?: number|string }} [opts]
 * @returns {{ id, width, height, cells: Uint8Array, start: {x,y}, goal: {x,y},
 *            depths: Int16Array, doorRequirements: Map }}
 */
export function generateLevel(width, height, { seed = 0, id = 1 } = {}) {
  const rng = makeRng(seed);

  // Padded grid dimensions (1-cell BLOCK border on all sides)
  const pw = width  + 2;
  const ph = height + 2;

  // ── Init padded grid ──
  const cells = new Array(pw * ph).fill(G.UNTOUCHED);
  for (let x = 0; x < pw; x++) {
    cells[x] = G.BLOCK;
    cells[(ph - 1) * pw + x] = G.BLOCK;
  }
  for (let y = 0; y < ph; y++) {
    cells[y * pw] = G.BLOCK;
    cells[y * pw + (pw - 1)] = G.BLOCK;
  }

  const idx = (x, y) => y * pw + x;

  // ── Place start ──
  const startX = 1 + Math.floor(rng() * width);
  const startY = 1 + Math.floor(rng() * height);
  cells[idx(startX, startY)] = G.EMPTY;

  // ── State tracking ──
  // visitedDirs: cellIndex → Set<dirKey> (directions already explored from here)
  const visitedDirs  = new Map();
  // onewayDir: cellIndex → dirKey  (the direction a ONEWAY cell allows)
  const onewayDir    = new Map();
  const branchPosSet = new Set();
  const branchQueue  = [];

  function hasVisited(i, dirKey) {
    return visitedDirs.get(i)?.has(dirKey) ?? false;
  }
  function markVisited(i, dirKey) {
    if (!visitedDirs.has(i)) visitedDirs.set(i, new Set());
    visitedDirs.get(i).add(dirKey);
  }
  function enqueue(x, y) {
    const key = `${x},${y}`;
    if (!branchPosSet.has(key)) {
      branchPosSet.add(key);
      branchQueue.push({ x, y });
    }
  }

  function pickType() {
    let r = rng() * WEIGHT_TOTAL;
    for (const [type, w] of Object.entries(WEIGHTS)) {
      if (r < w) return type;
      r -= w;
    }
    return 'empty';
  }

  // DFS carving — mirrors the reference goDirection
  function carve(dirKey, x, y) {
    const i = idx(x, y);
    if (hasVisited(i, dirKey)) return;
    markVisited(i, dirKey);

    const dir = DIRS.find(d => d.key === dirKey);
    const nx = x + dir.dx;
    const ny = y + dir.dy;
    const ni = idx(nx, ny);
    const cell = cells[ni];

    switch (cell) {
      case G.UNTOUCHED: {
        const type = pickType();
        if (type === 'empty') {
          cells[ni] = G.EMPTY;
          carve(dirKey, nx, ny);
        } else if (type === 'oneway') {
          // Only place a one-way if the cell beyond it is reachable
          const nnx = nx + dir.dx;
          const nny = ny + dir.dy;
          const nni = idx(nnx, nny);
          if (cells[nni] === G.UNTOUCHED || cells[nni] === G.EMPTY) {
            cells[nni] = G.EMPTY;
            cells[ni]  = G.ONEWAY;
            onewayDir.set(ni, dirKey);
          } else {
            cells[ni] = G.EMPTY;
          }
          carve(dirKey, nx, ny);
        } else if (type === 'block') {
          cells[ni] = G.BLOCK;
          enqueue(x, y);
        } else if (type === 'crumble') {
          cells[ni] = G.CRUMBLE;
          enqueue(x, y);
        } else { // sticky
          cells[ni] = G.STICKY;
          enqueue(nx, ny);
        }
        break;
      }
      case G.EMPTY:
        if (!hasVisited(ni, dirKey)) carve(dirKey, nx, ny);
        break;
      case G.BLOCK:
        enqueue(x, y);
        break;
      case G.STICKY:
        enqueue(nx, ny);
        break;
      case G.ONEWAY:
        enqueue(x, y);
        break;
    }
  }

  // ── Main generation loop ──
  enqueue(startX, startY);
  while (branchQueue.length > 0) {
    const { x, y } = branchQueue.shift();
    for (const dir of DIRS) carve(dir.key, x, y);
  }

  // ── Convert padded grid → output level cells ──
  const outCells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi   = idx(x + 1, y + 1);   // padded index
      const cell = cells[pi];
      let out;
      switch (cell) {
        case G.EMPTY:   out = 0; break;   // CellType.EMPTY
        case G.STICKY:  out = 2; break;   // CellType.STICKY
        case G.ONEWAY: {
          const dk = onewayDir.get(pi);
          out = dk ? ONEWAY_OUT[dk] : 0;
          break;
        }
        case G.CRUMBLE: out = 7; break;   // CellType.CRUMBLE
        default:        out = 1; break;   // CellType.WALL  (BLOCK + UNTOUCHED)
      }
      outCells[y * width + x] = out;
    }
  }

  const start = { x: startX - 1, y: startY - 1 };

  // First pass: find the goal without any key-door pair, so _tryPlaceKeyDoor
  // knows which cell to gate behind the door.
  const initial    = _findGoal(outCells, width, height, start, new Map());
  const kdResult   = _tryPlaceKeyDoor(outCells, width, height, start, initial.goal, rng);
  const doorRequirements = kdResult ? kdResult.doorRequirements : new Map();

  // Second pass: recompute goal / depths / difficulties now that KEY and DOOR
  // are placed (reaching the goal may now require collecting the key first).
  const { goal, depths, difficulties } = _findGoal(outCells, width, height, start, doorRequirements);
  const goalDifficulty = difficulties[goal.y * width + goal.x];

  _logLevel(outCells, width, height, start, goal, id, goalDifficulty);

  return { id, width, height, cells: outCells, start, goal, depths, difficulties, goalDifficulty, doorRequirements };
}

/**
 * Generate `candidates` levels (consecutive seeds) and return the hardest one
 * (highest goal difficulty — most cognitively demanding path to the goal).
 *
 * @param {number} width
 * @param {number} height
 * @param {{ seed?: number, id?: number|string, candidates?: number }} [opts]
 */
export function generateHardestLevel(width, height, { seed = 0, id = 1, candidates = 300 } = {}) {
  let best             = null;
  let bestDifficulty   = -1;
  let bestSeed         = seed;

  for (let i = 0; i < candidates; i++) {
    const level = generateLevel(width, height, { seed: seed + i, id });
    if (level.goalDifficulty > bestDifficulty) {
      bestDifficulty = level.goalDifficulty;
      bestSeed       = seed + i;
      best           = level;
    }
  }

  console.log(`[hardest] seed=${bestSeed}  goalDifficulty=${bestDifficulty.toFixed(2)}  (${candidates} candidates)`);
  return best;
}

// ── Debug logging ─────────────────────────────────────────────────────────────

function _logLevel(cells, width, height, start, goal, id, goalDifficulty) {
  const GLYPHS = ['.', '#', 'S', '←', '→', '↑', '↓', '░', 'K', 'D'];

  // Column header: "   x: 0 1 2 3 ..."
  const colHeader = '    x: ' + Array.from({ length: width }, (_, i) => i).join(' ');

  const lines = [colHeader, '       ' + '-'.repeat(width * 2 - 1)];
  for (let y = 0; y < height; y++) {
    const yLabel = String(y).padStart(2);
    let row = `y=${yLabel} | `;
    for (let x = 0; x < width; x++) {
      if (x > 0) row += ' ';
      if (x === start.x && y === start.y)     row += '@';
      else if (x === goal.x  && y === goal.y) row += 'G';
      else row += GLYPHS[cells[y * width + x]] ?? '?';
    }
    lines.push(row);
  }

  const legend = '  . empty  # wall  S sticky  ←→↑↓ oneway  ░ crumble  K key  D door  @ start  G goal';
  console.group(`[Level ${id}] ${width}×${height}`);
  console.log(lines.join('\n'));
  console.log(legend);
  console.log(`start=(${start.x},${start.y})  goal=(${goal.x},${goal.y})  difficulty=${goalDifficulty?.toFixed(2) ?? '?'}`);
  console.groupEnd();
}

// ── BFS goal finder ──────────────────────────────────────────────────────────

// Returns every cell traversed (in order), including the landing cell,
// plus the difficulty cost of executing this slide, and any events that
// occurred (crumble stopped slide; key collected at landing).
//
// toggleMap       : Map<flatIdx, toggleIdx>   — from buildToggleMap()
// worldState      : number                    — bitmask of active toggles
// doorRequirements: Map<flatIdx, toggleIdx>   — which toggle each door cell requires
function _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements = null) {
  const path = [];
  let x = pos.x, y = pos.y;
  let blockedByOneway  = false;
  let blockedByCrumble = false;
  let blockedByDoor    = false;
  let crumblePos       = null;
  let keyPos           = null;

  while (true) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
    const flatIdx = ny * width + nx;
    const cell    = cells[flatIdx];
    if (cell === 1) break;                                           // WALL

    if (cell === 7) {                                                // CRUMBLE
      const tIdx = toggleMap.get(flatIdx);
      if (tIdx === undefined || !(worldState & (1 << tIdx))) {
        crumblePos = { x: nx, y: ny, toggleIdx: tIdx };
        blockedByCrumble = true;
        break;
      }
      // Broken — treat as empty
    }

    if (cell === 8) {                                                // KEY
      const tIdx = toggleMap.get(flatIdx);
      const collected = tIdx !== undefined && (worldState & (1 << tIdx)) !== 0;
      if (!collected) {
        // Land on key, stop, mark collected
        x = nx; y = ny;
        path.push({ x, y, cell });
        keyPos = { x, y, toggleIdx: tIdx };
        break;
      }
      // Already collected — treat as empty (fall through)
    }

    if (cell === 9) {                                                // DOOR
      const req  = doorRequirements?.get(flatIdx);
      const open = req !== undefined && (worldState & (1 << req)) !== 0;
      if (!open) {
        blockedByDoor = true;
        break;
      }
      // Open — treat as empty (fall through)
    }

    if (cell >= 3 && cell <= 6 && !_onewayAllows(cell, dx, dy)) {
      blockedByOneway = true;                                        // ONEWAY wrong dir
      break;
    }
    x = nx; y = ny;
    path.push({ x, y, cell });
    if (cell === 2) break;                                           // STICKY
  }

  // Compute difficulty cost for this slide.
  let cost = (path.length === 0 && !blockedByOneway && !blockedByCrumble && !blockedByDoor) ? 0 : DIFFICULTY_WEIGHTS.BASE_MOVE;
  for (const { cell } of path) {
    if (cell === 2)             cost += DIFFICULTY_WEIGHTS.STICKY;
    if (cell >= 3 && cell <= 6) cost += DIFFICULTY_WEIGHTS.ONEWAY_TRAVERSE;
    if (cell === 8)             cost += DIFFICULTY_WEIGHTS.KEY;
    if (cell === 9)             cost += DIFFICULTY_WEIGHTS.DOOR_TRAVERSE;
  }
  if (blockedByOneway)  cost += DIFFICULTY_WEIGHTS.ONEWAY_BLOCKED;
  if (blockedByCrumble) cost += DIFFICULTY_WEIGHTS.CRUMBLE;
  if (blockedByDoor)    cost += DIFFICULTY_WEIGHTS.DOOR_LOCKED;

  return { path, cost, crumblePos, keyPos };
}

function _onewayAllows(cellType, dx, dy) {
  // ONEWAY_LEFT=3, RIGHT=4, UP=5, DOWN=6
  switch (cellType) {
    case 3: return dx === -1 && dy === 0;
    case 4: return dx ===  1 && dy === 0;
    case 5: return dx ===  0 && dy === -1;
    case 6: return dx ===  0 && dy ===  1;
    default: return true;
  }
}

// ── Key-door placement helpers ────────────────────────────────────────────────

/**
 * BFS over player landing positions.
 * Returns a Set<flatIdx> of every cell the player can stop at from startPos,
 * given the current cells, toggleMap, worldState, and doorRequirements.
 * Crumbles are treated as solid (worldState=0 means nothing broken yet).
 */
function _computeLandings(cells, width, height, startPos, toggleMap, worldState, doorRequirements) {
  const DIRS4 = [{ dx:-1,dy:0 }, { dx:1,dy:0 }, { dx:0,dy:-1 }, { dx:0,dy:1 }];
  const visited = new Set();
  const startFlat = startPos.y * width + startPos.x;
  visited.add(startFlat);
  const queue = [startPos];

  while (queue.length > 0) {
    const pos = queue.shift();
    for (const { dx, dy } of DIRS4) {
      const { path } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements);
      if (path.length > 0) {
        const landing = path[path.length - 1];
        const lk = landing.y * width + landing.x;
        if (!visited.has(lk)) {
          visited.add(lk);
          queue.push(landing);
        }
      }
    }
  }
  return visited;
}

/**
 * Attempt to place a key-door pair in outCells such that the goal is gated
 * behind the door.  Mutates cells in place on success.
 *
 * Returns { doorRequirements: Map<flatIdx, toggleIdx> } on success, or null
 * if no valid placement could be found.
 */
function _tryPlaceKeyDoor(cells, width, height, startPos, goalPos, rng) {
  const goalFlat  = goalPos.y  * width + goalPos.x;
  const startFlat = startPos.y * width + startPos.x;

  // Use an empty toggleMap so crumbles are treated as walls (solid, worldState=0).
  const emptyToggleMap = new Map();

  // Baseline: cells reachable from start with no door
  const allReachable = _computeLandings(cells, width, height, startPos, emptyToggleMap, 0, null);
  if (!allReachable.has(goalFlat)) return null;

  // Try each reachable empty cell as a candidate door position.
  // A valid door gates the goal (goal unreachable across the door) while
  // still leaving at least one free cell for the key.
  const candidates = [];
  for (const flat of allReachable) {
    if (flat === startFlat || flat === goalFlat) continue;
    if (cells[flat] !== 0) continue; // only empty cells become doors

    cells[flat] = 1; // temporarily wall-off
    const withDoor = _computeLandings(cells, width, height, startPos, emptyToggleMap, 0, null);
    cells[flat] = 0; // restore

    if (!withDoor.has(goalFlat) && withDoor.size >= 2) {
      candidates.push({ flat, freeReachable: withDoor });
    }
  }

  if (candidates.length === 0) return null;

  // Pick a random valid door position
  const chosen  = candidates[Math.floor(rng() * candidates.length)];
  const doorFlat = chosen.flat;

  // Pick a key position from the free side (reachable without door, not start or door)
  const freeForKey = Array.from(chosen.freeReachable).filter(
    f => f !== startFlat && f !== doorFlat && cells[f] === 0
  );
  if (freeForKey.length === 0) return null;

  const keyFlat = freeForKey[Math.floor(rng() * freeForKey.length)];

  // Place KEY(8) and DOOR(9) in cells
  cells[keyFlat]  = 8;
  cells[doorFlat] = 9;

  // Determine the key's toggle index: count of CRUMBLE+KEY cells before keyFlat
  // in flat scan order — this matches what buildToggleMap() will produce.
  let keyToggleIdx = 0;
  for (let i = 0; i < keyFlat; i++) {
    if (cells[i] === 7 || cells[i] === 8) keyToggleIdx++;
  }

  return { doorRequirements: new Map([[doorFlat, keyToggleIdx]]) };
}

function _findGoal(cells, width, height, start, doorRequirements = null) {
  const DIRS4 = [{ dx:-1,dy:0 }, { dx:1,dy:0 }, { dx:0,dy:-1 }, { dx:0,dy:1 }];

  // ── Build toggle map ───────────────────────────────────────────────────────
  // Assign a toggle index to every activating cell: CRUMBLE(7) and KEY(8).
  // worldState is a bitmask over these indices; 2^N possible universes.
  const toggleMap = new Map();
  let toggleCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (cells[i] === 7 || cells[i] === 8) toggleMap.set(i, toggleCount++); // CRUMBLE or KEY
  }

  // Key functions.
  // posKey    — identifies a grid cell for the output arrays (position only).
  // stateKey  — identifies a (position, worldState) pair for visited tracking.
  const posKey   = (p)     => p.y * width + p.x;
  const stateKey = (p, ws) => ws * width * height + p.y * width + p.x;

  // ── Pass 1: BFS for move-count depths (uniform cost) ──────────────────────
  // depths tracks the minimum number of moves to reach a position across ALL
  // universes (worldStates).  landingVisited prevents re-expanding the same
  // (pos, worldState) node twice.
  const landingVisited = new Map();
  const depths         = new Map(); // posKey → min depth over all worldStates

  landingVisited.set(stateKey(start, 0), 0);
  depths.set(posKey(start), 0);
  const bfsQueue = [{ pos: start, depth: 0, worldState: 0 }];

  while (bfsQueue.length > 0) {
    const { pos, depth, worldState } = bfsQueue.shift();

    if ((landingVisited.get(stateKey(pos, worldState)) ?? depth) < depth) continue;

    for (const { dx, dy } of DIRS4) {
      const { path, crumblePos, keyPos } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements);
      if (path.length === 0 && !crumblePos) continue;

      const nd = depth + 1;

      for (const p of path) {
        const k = posKey(p);
        if (!depths.has(k) || depths.get(k) > nd) depths.set(k, nd);
      }

      if (path.length > 0) {
        const landing = path[path.length - 1];
        // Key collection happens at the landing cell — fold it into worldState.
        const effectiveWS = keyPos ? (worldState | (1 << keyPos.toggleIdx)) : worldState;
        const lk = stateKey(landing, effectiveWS);
        if ((landingVisited.get(lk) ?? Infinity) > nd) {
          landingVisited.set(lk, nd);
          bfsQueue.push({ pos: landing, depth: nd, worldState: effectiveWS });
        }
      }

      // Crumble break: transition to a new universe where that crumble is gone.
      // The player remains at their landing position (or start pos if no movement)
      // in the new worldState — no extra move is charged for the break itself.
      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk  = posKey(from);
        if (!depths.has(fk) || depths.get(fk) > nd) depths.set(fk, nd);
        const lk = stateKey(from, newWorldState);
        if ((landingVisited.get(lk) ?? Infinity) > nd) {
          landingVisited.set(lk, nd);
          bfsQueue.push({ pos: from, depth: nd, worldState: newWorldState });
        }
      }
    }
  }

  // ── Pass 2: Dijkstra for difficulty (variable cost) ───────────────────────
  const difficulties   = new Map(); // posKey → min difficulty over all worldStates
  const diffLandingVis = new Map();

  difficulties.set(posKey(start), 0);
  diffLandingVis.set(stateKey(start, 0), 0);

  const heap = [{ pos: start, diff: 0, worldState: 0 }];

  function heapPush(entry) {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].diff <= heap[i].diff) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && heap[l].diff < heap[smallest].diff) smallest = l;
        if (r < heap.length && heap[r].diff < heap[smallest].diff) smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  }

  while (heap.length > 0) {
    const { pos, diff, worldState } = heapPop();
    if ((diffLandingVis.get(stateKey(pos, worldState)) ?? Infinity) < diff) continue;

    for (const { dx, dy } of DIRS4) {
      const { path, cost, crumblePos, keyPos } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements);
      if (path.length === 0 && !crumblePos) continue;

      const nd = diff + cost;

      for (const p of path) {
        const k = posKey(p);
        if (!difficulties.has(k) || difficulties.get(k) > nd) difficulties.set(k, nd);
      }

      if (path.length > 0) {
        const landing = path[path.length - 1];
        const effectiveWS = keyPos ? (worldState | (1 << keyPos.toggleIdx)) : worldState;
        const lk = stateKey(landing, effectiveWS);
        if ((diffLandingVis.get(lk) ?? Infinity) > nd) {
          diffLandingVis.set(lk, nd);
          heapPush({ pos: landing, diff: nd, worldState: effectiveWS });
        }
      }

      // Crumble break: transition to new worldState, no extra difficulty charge.
      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk  = posKey(from);
        if (!difficulties.has(fk) || difficulties.get(fk) > nd) difficulties.set(fk, nd);
        const lk = stateKey(from, newWorldState);
        if ((diffLandingVis.get(lk) ?? Infinity) > nd) {
          diffLandingVis.set(lk, nd);
          heapPush({ pos: from, diff: nd, worldState: newWorldState });
        }
      }
    }
  }

  // ── Build flat arrays: -1 = unreachable ──────────────────────────────────
  const depthArray      = new Int16Array(width * height).fill(-1);
  const difficultyArray = new Float32Array(width * height).fill(-1);
  for (const [k, d] of depths)       depthArray[k]      = d;
  for (const [k, d] of difficulties) difficultyArray[k] = d;

  // ── Pick goal: non-wall cell with highest difficulty ──────────────────────
  let bestPos        = start;
  let bestDifficulty = 0;
  let bestManhattan  = 0;
  for (const [k, d] of difficulties) {
    if (cells[k] === 1 || cells[k] === 8 || cells[k] === 9) continue;  // skip walls, keys, doors
    const x  = k % width;
    const y  = Math.floor(k / width);
    const nm = Math.abs(x - start.x) + Math.abs(y - start.y);
    if (d > bestDifficulty || (d === bestDifficulty && nm > bestManhattan)) {
      bestDifficulty = d;
      bestManhattan  = nm;
      bestPos        = { x, y };
    }
  }

  return { goal: bestPos, depths: depthArray, difficulties: difficultyArray };
}

