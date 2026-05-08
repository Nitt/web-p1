import { makeRng } from './random.js';

// ── Internal generator cell values ──────────────────────────────────────────
const G = { UNTOUCHED: 0, EMPTY: 1, STICKY: 2, BLOCK: 3, ONEWAY: 4, CRUMBLE: 5 };

const DIRS = [
  { key: 'LEFT',  dx: -1, dy:  0 },
  { key: 'UP',    dx:  0, dy: -1 },
  { key: 'RIGHT', dx:  1, dy:  0 },
  { key: 'DOWN',  dx:  0, dy:  1 },
];

// Probability weights for choosing a cell type when carving into UNTOUCHED — used as defaults
const WEIGHTS = { sticky: 0.06, block: 0.10, oneway: 0.02, crumble: 0.07, empty: 1.00 };

// Maps a ONEWAY direction key → the CellType value used in the output level
const ONEWAY_OUT = { LEFT: 3, RIGHT: 4, UP: 5, DOWN: 6 };

// ── Difficulty weights ────────────────────────────────────────────────────────
// Each entry represents the cognitive cost added to a move when that interaction
// occurs. BASE_MOVE is applied once per slide action. All others stack on top.
// Add new cell types here as they are introduced (crumbles, keys, doors, etc.).
export const DIFFICULTY_WEIGHTS = {
  BASE_MOVE:       1.0,   // every slide, regardless of length
  SLIDE_LENGTH:    0.15,  // bonus per cell traversed beyond the first (longer slides = harder to track)
  STICKY:          0.5,   // landing on a sticky cell (easy to predict, minor load)
  ONEWAY_TRAVERSE: 1.0,   // passing through a one-way in the allowed direction
  ONEWAY_BLOCKED:  2.5,   // stopped by a one-way approaching from the wrong direction
  CRUMBLE:         1.5,   // stopped by a crumble block (records the topology change)
  CRUMBLE_TRAVERSE: 3.0,  // sliding through a cell where a crumble was previously broken
  KEY:             2.5,   // stopping to collect a key
  DOOR_TRAVERSE:   1.0,   // sliding through an already-open door
  DOOR_LOCKED:     3.5,   // stopped by a locked door (high load — player must find the key)
  CHAIN_CROSSING:  3.0,   // shortest path requires revisiting a previous waypoint (chain shortens)
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a level using a randomised BFS carving algorithm.
 *
 * @param {number} width   - inner column count (no padding)
 * @param {number} height  - inner row count
 * @param {{ seed?: number, id?: number|string }} [opts]
 * @returns {{ id, width, height, cells: Uint8Array, start: {x,y}, goal: {x,y},
 *            depths: Int16Array, doorRequirements: Map }}
 */
export function generateLevel(width, height, { seed = 0, id = 1, weights = WEIGHTS, useKeyDoor = true, _steps = null } = {}) {
  const rng = makeRng(seed);
  const weightTotal = Object.values(weights).reduce((a, b) => a + b, 0);

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

  // ── Place start — always top-center; start is above the grid (y = -1) ──
  // The entry tunnel: two cells forced empty so the player always slides through
  // both before any decision point.  The carver begins from the second cell so
  // the first cell (directly under the boat) is never enqueued as a BFS source
  // and therefore never explored in all four directions.
  const startX = 1 + Math.floor(width / 2);
  const startY = 1;
  cells[idx(startX, startY)]     = G.EMPTY;  // pass-through — player always slides through
  cells[idx(startX, startY + 1)] = G.EMPTY;  // second tunnel cell — actual carve origin

  // Wall off every other cell in the entry row so they don't remain UNTOUCHED
  // (which maps to output EMPTY and would let the player slide across the top).
  for (let px = 1; px < pw - 1; px++) {
    if (px !== startX) cells[idx(px, startY)] = G.BLOCK;
  }

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

  // Pre-mark the entry cell visited in all directions so carve() can never
  // enqueue it or explore laterally from it.  It remains G.EMPTY so the player
  // slides through it, but it is never a BFS decision point.
  for (const d of DIRS) markVisited(idx(startX, startY), d.key);

  function pickType() {
    let r = rng() * weightTotal;
    for (const [type, w] of Object.entries(weights)) {
      if (r < w) return type;
      r -= w;
    }
    return 'empty';
  }

  // ── Step recorder (no-op when _steps is null) ──
  function rec(fromX, fromY, toX, toY, label) {
    if (!_steps) return;
    _steps.push({ grid: new Uint8Array(cells), onewayDir: new Map(onewayDir), visitedDirs: new Map([...visitedDirs].map(([k, s]) => [k, new Set(s)])), pw, ph, fromX, fromY, toX, toY, label });
  }

  // Carving — slide physics respected: recursion continues same-direction slides
  // through empty/oneway cells (one slide = one logical step).  The only place
  // we enqueue instead of recurse is the post-crumble universe continuation,
  // because that is a genuinely new branch that belongs in the next BFS wave.
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
          rec(x, y, nx, ny, `empty (${nx-1},${ny-1})`);
          carve(dirKey, nx, ny);          // same slide, continue in same direction
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
          rec(x, y, nx, ny, `oneway-${dirKey} (${nx-1},${ny-1})`);
          carve(dirKey, nx, ny);          // same slide, continue through oneway
        } else if (type === 'block') {
          cells[ni] = G.BLOCK;
          rec(x, y, nx, ny, `block (${nx-1},${ny-1})`);
          enqueue(x, y);
        } else if (type === 'crumble') {
          cells[ni] = G.CRUMBLE;
          rec(x, y, nx, ny, `crumble (${nx-1},${ny-1})`);
          enqueue(x, y);                  // stop before crumble — explore other dirs from here
          // Post-crumble parallel universe: from the same pre-crumble cell, the crumble
          // is gone so the slide continues through it.  Re-queue (x,y) with a resumeDir
          // so the continuation fires in BFS order from the actual landing position.
          branchQueue.push({ x, y, resumeDir: dirKey });
        } else { // sticky
          cells[ni] = G.STICKY;
          rec(x, y, nx, ny, `sticky (${nx-1},${ny-1})`);
          enqueue(nx, ny);
        }
        break;
      }
      case G.EMPTY:
        rec(x, y, nx, ny, `slide-empty (${nx-1},${ny-1})`);
        if (!hasVisited(ni, dirKey)) carve(dirKey, nx, ny);  // continue slide if direction is new
        break;
      case G.CRUMBLE:
        rec(x, y, nx, ny, `slide-crumble-gone (${nx-1},${ny-1})`);
        if (!hasVisited(ni, dirKey)) carve(dirKey, nx, ny);  // parallel universe: crumble is gone, slide through
        break;
      case G.BLOCK:
        rec(x, y, nx, ny, `stopped-block (${nx-1},${ny-1})`);
        enqueue(x, y);
        break;
      case G.STICKY:
        rec(x, y, nx, ny, `stopped-sticky (${nx-1},${ny-1})`);
        enqueue(nx, ny);
        break;
      case G.ONEWAY: {
        const allowedDir = onewayDir.get(ni);
        if (allowedDir === dirKey) {
          rec(x, y, nx, ny, `slide-oneway-allowed (${nx-1},${ny-1})`);
          carve(dirKey, nx, ny);  // correct direction — slide through
        } else {
          rec(x, y, nx, ny, `stopped-oneway-blocked (${nx-1},${ny-1})`);
          enqueue(x, y);          // wrong direction — blocked before it
        }
        break;
      }
    }
  }

  // ── Main generation loop ──
  // Begin carving from the second tunnel cell (startY+1), one row below the
  // boat entry.  This ensures the entry cell (startY) is never enqueued as a
  // BFS source and so is never explored laterally — matching the player physics
  // where the first slide always passes through the entry cell.
  carve('DOWN', startX, startY + 1);
  while (branchQueue.length > 0) {
    const { x, y, resumeDir } = branchQueue.shift();
    if (resumeDir) {
      // Post-crumble parallel universe: un-mark dirKey so carve can slide through the crumble.
      visitedDirs.get(idx(x, y))?.delete(resumeDir);
      carve(resumeDir, x, y);
    } else {
      if (_steps) _steps.push({ grid: new Uint8Array(cells), onewayDir: new Map(onewayDir), visitedDirs: new Map([...visitedDirs].map(([k, s]) => [k, new Set(s)])), pw, ph, fromX: x, fromY: y, toX: -1, toY: -1, label: `▶ processing (${x-1},${y-1})  queue: ${branchQueue.length} remaining` });
      for (const dir of DIRS) carve(dir.key, x, y);
    }
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
        case G.BLOCK:   out = 1; break;   // CellType.WALL
        default:        out = 0; break;   // CellType.EMPTY  (UNTOUCHED — never carved)
      }
      outCells[y * width + x] = out;
    }
  }

  // Mark which output cells were explicitly carved (not left UNTOUCHED).
  // Used to prevent placing the goal on accidental open cells the carver never reached.
  const carvedMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[idx(x + 1, y + 1)] !== G.UNTOUCHED) carvedMask[y * width + x] = 1;
    }
  }

  const start = { x: startX - 1, y: -1 };

  // First pass: find the goal without any key-door pair, so _tryPlaceKeyDoor
  // knows which cell to gate behind the door.
  const initial    = _findGoal(outCells, width, height, start, new Map(), carvedMask);
  const kdResult   = useKeyDoor ? _tryPlaceKeyDoor(outCells, width, height, start, initial.goal, rng) : null;
  const doorRequirements = kdResult ? kdResult.doorRequirements : new Map();

  // Second pass: recompute goal / depths / difficulties now that KEY and DOOR
  // are placed (reaching the goal may now require collecting the key first).
  const { goal, depths, difficulties } = _findGoal(outCells, width, height, start, doorRequirements, carvedMask);
  const goalDifficulty = difficulties[goal.y * width + goal.x];

  // Translate visitedDirs from padded indices → unpadded flat indices for export
  const visitedDirsOut = new Map();
  for (const [pi, dirs] of visitedDirs) {
    const px = pi % pw, py = Math.floor(pi / pw);
    if (px >= 1 && px < pw - 1 && py >= 1 && py < ph - 1) {
      visitedDirsOut.set((py - 1) * width + (px - 1), new Set(dirs));
    }
  }

  return { id, width, height, cells: outCells, start, goal, depths, difficulties, goalDifficulty, doorRequirements, seed, visitedDirs: visitedDirsOut };
}

/**
 * Generate `candidates` levels (consecutive seeds) and return the hardest one
 * (highest goal difficulty — most cognitively demanding path to the goal).
 *
 * @param {number} width
 * @param {number} height
 * @param {{ seed?: number, id?: number|string, candidates?: number }} [opts]
 */
export function generateHardestLevel(width, height, { seed = 0, id = 1, candidates = 300, weights = WEIGHTS, useKeyDoor = true, difficultyTarget = null } = {}) {
  let best           = null;
  let bestScore      = Infinity; // used as |diff - target| when targeting, -Infinity when maximising
  let bestSeed       = seed;

  for (let i = 0; i < candidates; i++) {
    const level = generateLevel(width, height, { seed: seed + i, id, weights, useKeyDoor });
    const d = level.goalDifficulty;
    const score = difficultyTarget !== null ? Math.abs(d - difficultyTarget) : -d;
    if (score < bestScore) {
      bestScore = score;
      bestSeed  = seed + i;
      best      = level;
      // Close enough to the target — no point evaluating more candidates.
      if (difficultyTarget !== null && bestScore < 0.5) break;
    }
  }

  const label = difficultyTarget !== null
    ? `target=${difficultyTarget}  closest=${best.goalDifficulty.toFixed(2)}`
    : `goalDifficulty=${best.goalDifficulty.toFixed(2)}`;
  console.log(`[hardest] seed=${bestSeed}  ${label}  (${candidates} candidates)`);
  best.weights = weights;
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
function _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements = null, gearSet = null) {
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
    if (gearSet && gearSet.has(flatIdx)) break;                      // GEAR (acts as sticky)
  }

  // Compute difficulty cost for this slide.
  let cost = (path.length === 0 && !blockedByOneway && !blockedByCrumble && !blockedByDoor) ? 0 : DIFFICULTY_WEIGHTS.BASE_MOVE;
  if (path.length > 1) cost += (path.length - 1) * DIFFICULTY_WEIGHTS.SLIDE_LENGTH;
  for (const { cell } of path) {
    if (cell === 2)             cost += DIFFICULTY_WEIGHTS.STICKY;
    if (cell >= 3 && cell <= 6) cost += DIFFICULTY_WEIGHTS.ONEWAY_TRAVERSE;
    if (cell === 7)             cost += DIFFICULTY_WEIGHTS.CRUMBLE_TRAVERSE;
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
  let head = 0;

  while (head < queue.length) {
    const pos = queue[head++];
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

// ── Per-step analysis for debug visualiser ────────────────────────────────────

/**
 * Given a single step snapshot from the _steps array, convert the partial
 * padded grid to output cells (treating UNTOUCHED as WALL) and run _findGoal
 * to compute depths/difficulties for just the cells carved so far.
 *
 * @param {{ grid: Uint8Array, onewayDir: Map, pw: number, ph: number }} step
 * @param {number} width   - inner (unpadded) column count
 * @param {number} height  - inner row count
 * @param {{ x: number, y: number }} start
 * @returns {{ depths: Int16Array, difficulties: Float32Array }}
 */
export function computeStepAnalysis(step, width, height, start) {
  const { grid, onewayDir, pw } = step;
  const ONEWAY_OUT_MAP = { LEFT: 3, RIGHT: 4, UP: 5, DOWN: 6 };
  const outCells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi   = (y + 1) * pw + (x + 1);
      const cell = grid[pi];
      let out;
      switch (cell) {
        case 1: out = 0; break; // G.EMPTY   → CellType.EMPTY
        case 2: out = 2; break; // G.STICKY  → CellType.STICKY
        case 4: {               // G.ONEWAY  → directional CellType
          const dk = onewayDir?.get(pi);
          out = dk ? ONEWAY_OUT_MAP[dk] : 0;
          break;
        }
        case 5: out = 7; break; // G.CRUMBLE → CellType.CRUMBLE
        case 3: out = 1; break; // G.BLOCK   → CellType.WALL
        default: out = 1; break; // G.UNTOUCHED → treat as WALL (not yet carved)
      }
      outCells[y * width + x] = out;
    }
  }
  const { depths, difficulties } = _findGoal(outCells, width, height, start, null, null);
  return { depths, difficulties };
}

function _findGoal(cells, width, height, start, doorRequirements = null, carvedMask = null) {
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
  // stateKey  — identifies a (position, incoming-slide-direction, worldState) triple
  //             for visited tracking.  Including direction means the same cell reached
  //             via a RIGHT slide vs. a LEFT slide is treated as a distinct BFS node,
  //             so one-way interactions are explored correctly from every approach angle.
  const posKey   = (p)         => p.y * width + p.x;
  const stateKey = (p, di, ws) => (ws * width * height + p.y * width + p.x) * 5 + di;
  // di = 0..3 index into DIRS4, or 4 for the start node (no incoming direction).

  // ── Pass 1: BFS for move-count depths ────────────────────────────────────
  // depths tracks the minimum slide-count at which a cell is reachable (either
  // as a landing or as a cell the player passes through on that slide).
  // Depths are set per-cell as the slide is simulated inline — no path list.
  const landingVisited  = new Map();
  const depths          = new Map();

  // Parent-pointer tables for path-crossing detection (added after BFS completes).
  // parentOf     : stateKey → { fromKey, landing: {x,y} }
  // bestKeyForPos: posFlat  → stateKey at minimum depth (in-grid cells only)
  const parentOf      = new Map();
  const bestKeyForPos = new Map();

  const startKey = stateKey(start, 4, 0);
  parentOf.set(startKey, { fromKey: null, landing: start });

  landingVisited.set(stateKey(start, 4, 0), 0);
  depths.set(posKey(start), 0);
  const bfsQueue = [{ pos: start, depth: 0, worldState: 0, di: 4 }];
  let bfsHead = 0;

  while (bfsHead < bfsQueue.length) {
    const { pos, depth, worldState, di } = bfsQueue[bfsHead++];

    if ((landingVisited.get(stateKey(pos, di, worldState)) ?? depth) < depth) continue;

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];
      const { path, crumblePos, keyPos } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements);
      if (path.length === 0 && !crumblePos) continue;

      const nd = depth + 1;

      // Set depth for every cell reached on this slide (same nd — one slide action).
      for (const p of path) {
        const k = posKey(p);
        if (!depths.has(k) || depths.get(k) > nd) depths.set(k, nd);
      }

      if (path.length > 0) {
        const landing    = path[path.length - 1];
        const effectiveWS = keyPos ? (worldState | (1 << keyPos.toggleIdx)) : worldState;
        const lk = stateKey(landing, i, effectiveWS);
        if ((landingVisited.get(lk) ?? Infinity) > nd) {
          landingVisited.set(lk, nd);
          parentOf.set(lk, { fromKey: stateKey(pos, di, worldState), landing });
          const pf = posKey(landing);
          if (!bestKeyForPos.has(pf)) bestKeyForPos.set(pf, lk);
          bfsQueue.push({ pos: landing, depth: nd, worldState: effectiveWS, di: i });
        }
      }

      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk   = posKey(from);
        if (!depths.has(fk) || depths.get(fk) > nd) depths.set(fk, nd);
        const lk = stateKey(from, i, newWorldState);
        if ((landingVisited.get(lk) ?? Infinity) > nd) {
          landingVisited.set(lk, nd);
          parentOf.set(lk, { fromKey: stateKey(pos, di, worldState), landing: from });
          const pf = posKey(from);
          if (!bestKeyForPos.has(pf)) bestKeyForPos.set(pf, lk);
          bfsQueue.push({ pos: from, depth: nd, worldState: newWorldState, di: i });
        }
      }
    }
  }

  // ── Pass 2: Dijkstra for difficulty (variable cost) ───────────────────────
  const difficulties   = new Map(); // posKey → min difficulty over all worldStates
  const diffLandingVis = new Map();

  difficulties.set(posKey(start), 0);
  diffLandingVis.set(stateKey(start, 4, 0), 0);

  const heap = [{ pos: start, diff: 0, worldState: 0, di: 4 }];

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
    const { pos, diff, worldState, di } = heapPop();
    if ((diffLandingVis.get(stateKey(pos, di, worldState)) ?? Infinity) < diff) continue;

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];
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
        const lk = stateKey(landing, i, effectiveWS);
        if ((diffLandingVis.get(lk) ?? Infinity) > nd) {
          diffLandingVis.set(lk, nd);
          heapPush({ pos: landing, diff: nd, worldState: effectiveWS, di: i });
        }
      }

      // Crumble break: transition to new worldState, no extra difficulty charge.
      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk  = posKey(from);
        if (!difficulties.has(fk) || difficulties.get(fk) > nd) difficulties.set(fk, nd);
        const lk = stateKey(from, i, newWorldState);
        if ((diffLandingVis.get(lk) ?? Infinity) > nd) {
          diffLandingVis.set(lk, nd);
          heapPush({ pos: from, diff: nd, worldState: newWorldState, di: i });
        }
      }
    }
  }

  // ── Build flat arrays: -1 = unreachable ──────────────────────────────────
  const depthArray      = new Int16Array(width * height).fill(-1);
  const difficultyArray = new Float32Array(width * height).fill(-1);
  for (const [k, d] of depths)       depthArray[k]      = d;
  for (const [k, d] of difficulties) difficultyArray[k] = d;

  // ── Chain-crossing bonus ──────────────────────────────────────────────────
  // For every valid goal candidate, trace back its shortest path via parentOf.
  // If the traced sequence of landing cells contains any duplicate (i.e. the
  // optimal solution requires revisiting a waypoint, shortening the chain),
  // award a CHAIN_CROSSING difficulty bonus.  The goal-picker below then
  // naturally favours these cells when comparing candidates.
  for (let k = 0; k < width * height; k++) {
    if (difficultyArray[k] < 0) continue;
    if (cells[k] === 1 || cells[k] === 7 || cells[k] === 8 || cells[k] === 9) continue;
    if (cells[k] >= 3 && cells[k] <= 6) continue;
    const key = bestKeyForPos.get(k);
    if (key === undefined) continue;
    // Trace path back to start; detect any repeated in-grid landing position.
    const seen = new Set();
    let cur = key;
    let hasCrossing = false;
    while (cur !== null && cur !== undefined) {
      const entry = parentOf.get(cur);
      if (!entry) break;
      if (entry.landing && entry.landing.y >= 0) {
        const flat = posKey(entry.landing);
        if (seen.has(flat)) { hasCrossing = true; break; }
        seen.add(flat);
      }
      cur = entry.fromKey;
    }
    if (hasCrossing) difficultyArray[k] += DIFFICULTY_WEIGHTS.CHAIN_CROSSING;
  }

  // ── Pick goal: non-wall cell with highest difficulty ──────────────────────
  // Exclude walls, crumbles (goal hidden under crumble = unreachable), keys, doors,
  // and one-ways (player slides through them — can never land on a one-way tile).
  let bestPos        = start;
  let bestDifficulty = 0;
  let bestManhattan  = 0;
  for (const [k, d] of difficulties) {
    if (k < 0 || k >= width * height) continue;                        // skip off-grid keys (e.g. boat at y=-1)
    if (cells[k] === 1 || cells[k] === 7 || cells[k] === 8 || cells[k] === 9) continue;  // skip walls, crumbles, keys, doors
    if (cells[k] >= 3 && cells[k] <= 6) continue;                          // skip one-ways (player slides through, never lands on them)
    if (carvedMask && !carvedMask[k]) continue;                         // skip UNTOUCHED cells the carver never reached
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

