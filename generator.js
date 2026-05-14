import { makeRng } from './random.js';

// ── Internal generator cell values ──────────────────────────────────────────
const G = { UNTOUCHED: 0, EMPTY: 1, STICKY: 2, BLOCK: 3, ONEWAY: 4, CRUMBLE: 5, KEY: 6, DOOR: 7 };

const DIRS = [
  { key: 'LEFT',  idx: 0, dx: -1, dy:  0 },
  { key: 'UP',    idx: 1, dx:  0, dy: -1 },
  { key: 'RIGHT', idx: 2, dx:  1, dy:  0 },
  { key: 'DOWN',  idx: 3, dx:  0, dy:  1 },
];

// Probability weights for choosing a cell type when carving into UNTOUCHED — used as defaults
const WEIGHTS = { sticky: 0.06, block: 0.10, oneway: 0.02, crumble: 0.07, key: 0.05, empty: 1.00 };

// Maps a ONEWAY direction index (matching DIRS .idx) → the CellType value used in the output level
// Order: LEFT(0)→3, UP(1)→5, RIGHT(2)→4, DOWN(3)→6
const ONEWAY_OUT = [3, 5, 4, 6];

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
  // Sync the 'key' weight with useKeyDoor: inject a default if missing when enabled,
  // strip it if present when disabled — so pickType() and useKeyDoor always agree.
  if (useKeyDoor && !('key' in weights)) weights = { ...weights, key: 0.05 };
  else if (!useKeyDoor && 'key' in weights) { weights = { ...weights }; delete weights.key; }
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
  // Each universe has its own visited-directions map so exploration is truly independent.
  // universeKey = sorted activated padded-cell-indices joined by ','. Base universe = ''.
  const universeVDs      = new Map();
  universeVDs.set('', new Map());
  let currentVD          = universeVDs.get('');  // pointer to the active universe's VD
  let currentUniverseKey = '';
  // onewayDir: cellIndex → dirIdx  (the direction index a ONEWAY cell allows)
  const onewayDir        = new Map();
  const branchPosSet     = new Set();   // dedup key: `${universeKey}|${x},${y}`
  const branchQueue      = [];
  // Active-universe state — updated whenever a branch is dequeued.
  let currentBranchActivated = [];
  let currentActivatedSet    = new Set();
  // Maps padded door idx → padded key idx, populated as keys are placed.
  const doorToKeyPaddedMap   = new Map();

  // Direction-index helpers — operate on the CURRENT universe's VD.
  function hasVisited(i, dirIdx) {
    return ((currentVD.get(i) ?? 0) & (1 << dirIdx)) !== 0;
  }
  function markVisited(i, dirIdx) {
    currentVD.set(i, (currentVD.get(i) ?? 0) | (1 << dirIdx));
  }
  function enqueue(x, y) {
    const key = `${currentUniverseKey}|${x},${y}`;
    if (!branchPosSet.has(key)) {
      branchPosSet.add(key);
      branchQueue.push({ x, y, activated: currentBranchActivated.slice() });
    }
  }

  // Tracks key→door linkages placed during carving, used to build doorRequirements after output conversion.
  const keyDoorPairs = [];

  // Find a random BLOCK cell adjacent to at least one EMPTY cell — candidate for conversion to DOOR.
  function findDoorCandidate(excludeI) {
    const candidates = [];
    for (let py = startY + 1; py < ph - 1; py++) {
      for (let px = 1; px < pw - 1; px++) {
        const ci = idx(px, py);
        if (ci === excludeI || cells[ci] !== G.BLOCK) continue;
        for (const dir of DIRS) {
          if (cells[idx(px + dir.dx, py + dir.dy)] === G.EMPTY) {
            candidates.push({ px, py, ci });
            break;
          }
        }
      }
    }
    return candidates.length ? candidates[Math.floor(rng() * candidates.length)] : null;
  }

  // For exporting/snapshotting visitedDirs in the Set<string> format expected
  // by the renderer and debug visualiser.
  const DIR_KEYS = ['LEFT', 'UP', 'RIGHT', 'DOWN'];
  function dirBitsToSet(bits) {
    const set = new Set();
    for (let i = 0; i < 4; i++) if (bits & (1 << i)) set.add(DIR_KEYS[i]);
    return set;
  }

  // Pre-mark the entry cell visited in all directions so carve() can never
  // enqueue it or explore laterally from it.  It remains G.EMPTY so the player
  // slides through it, but it is never a BFS decision point.
  for (let i = 0; i < DIRS.length; i++) markVisited(idx(startX, startY), i);

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
    // Snapshot every universe's VD so the visualiser can show per-universe exploration.
    const allUniverseVDs = new Map();
    for (const [k, vd] of universeVDs) {
      allUniverseVDs.set(k, new Map([...vd].map(([ci, bits]) => [ci, dirBitsToSet(bits)])));
    }
    // Also surface universes that are queued but not yet dequeued — universeVDs
    // only gets an entry on dequeue, so without this new panels wouldn't appear
    // until the branch is actually processed.
    for (const item of branchQueue) {
      const uKey = (item.activated ?? []).join(',');
      if (!allUniverseVDs.has(uKey) && item.initialVD) {
        allUniverseVDs.set(uKey, new Map([...item.initialVD].map(([ci, bits]) => [ci, dirBitsToSet(bits)])));
      }
    }
    // Snapshot the frontier grouped by universe key.
    // doorFrontier = blue dots: cells re-queued because a wall became a door.
    const frontier     = new Map();
    const doorFrontier = new Map();
    for (const item of branchQueue) {
      const uKey = (item.activated ?? []).join(',');
      const target = item.isDoorRequeue ? doorFrontier : frontier;
      if (!target.has(uKey)) target.set(uKey, new Set());
      target.get(uKey).add(item.y * pw + item.x);
    }
    _steps.push({ grid: new Uint8Array(cells), onewayDir: new Map(onewayDir), allUniverseVDs, frontier, doorFrontier, currentUniverseKey, pw, ph, fromX, fromY, toX, toY, label, activated: currentBranchActivated.slice() });
  }

  // True when at least two cells beyond (nx, ny) in dir are reachable — required
  // before placing a one-way so the player slides far enough past it to learn its effect.
  function hasOnewayRoom(nx, ny, dir) {
    const nnx = nx + dir.dx, nny = ny + dir.dy;
    const nnnx = nnx + dir.dx, nnny = nny + dir.dy;
    const ok = v => v === G.UNTOUCHED || v === G.EMPTY;
    return ok(cells[idx(nnx, nny)]) && ok(cells[idx(nnnx, nnny)]);
  }

  function carveUntouched(dirIdx, x, y, nx, ny, ni, dir) {
    const type = pickType();
    if (type === 'empty') {
      cells[ni] = G.EMPTY;
      rec(x, y, nx, ny, `empty (${nx-1},${ny-1})`);
      carve(dirIdx, nx, ny);
    } else if (type === 'oneway') {
      if (hasOnewayRoom(nx, ny, dir)) {
        cells[idx(nx + dir.dx, ny + dir.dy)] = G.EMPTY;
        cells[ni] = G.ONEWAY;
        onewayDir.set(ni, dirIdx);
      } else {
        cells[ni] = G.EMPTY;
      }
      rec(x, y, nx, ny, `oneway-${dir.key} (${nx-1},${ny-1})`);
      carve(dirIdx, nx, ny);
    } else if (type === 'block') {
      cells[ni] = G.BLOCK;
      rec(x, y, nx, ny, `block (${nx-1},${ny-1})`);
      enqueue(x, y);
    } else if (type === 'crumble') {
      cells[ni] = G.CRUMBLE;
      rec(x, y, nx, ny, `crumble (${nx-1},${ny-1})`);
      // Queue (x,y) only in the crumble-activated universe with a fresh VD.
      // Bumping a crumble immediately activates it, so there is no game state
      // where the player is at (x,y) with the crumble still intact.
      { const ca = [...currentBranchActivated, ni].sort((a, b) => a - b);
        const cuk = ca.join(',');
        const bpk = `${cuk}|${x},${y}`;
        if (!branchPosSet.has(bpk)) { branchPosSet.add(bpk); branchQueue.push({ x, y, activated: ca }); } }
    } else if (type === 'key' && useKeyDoor && keyDoorPairs.length === 0) {
      const door = findDoorCandidate(ni);
      if (door) {
        cells[ni] = G.KEY;
        cells[door.ci] = G.DOOR;
        keyDoorPairs.push({ keyI: ni, doorI: door.ci });
        doorToKeyPaddedMap.set(door.ci, ni);
        rec(x, y, nx, ny, `key (${nx-1},${ny-1})`);
        // Queue the key cell in the key-activated universe with a fresh VD.
        // The player lands on the key and immediately collects it, so exploration
        // starts clean — no inherited visited-dirs from before the key was collected.
        // The carver will reach the door naturally from the key side and slide through
        // (door is open), so no extra far-side seeding is needed.
        { const ka = [...currentBranchActivated, ni].sort((a, b) => a - b);
          const kuk = ka.join(',');
          const bpk = `${kuk}|${nx},${ny}`;
          if (!branchPosSet.has(bpk)) { branchPosSet.add(bpk); branchQueue.push({ x: nx, y: ny, activated: ka }); } }
      } else {
        cells[ni] = G.EMPTY;
        rec(x, y, nx, ny, `empty (${nx-1},${ny-1})`);
        carve(dirIdx, nx, ny);
      }
    } else {
      cells[ni] = G.STICKY;
      rec(x, y, nx, ny, `sticky (${nx-1},${ny-1})`);
      enqueue(nx, ny);
    }
  }

  // Carving — slide physics respected: same-direction recursion continues through
  // empty/oneway cells (one slide = one logical step).
  function carve(dirIdx, x, y) {
    const i = idx(x, y);
    if (hasVisited(i, dirIdx)) return;
    markVisited(i, dirIdx);

    const dir  = DIRS[dirIdx];
    const nx   = x + dir.dx;
    const ny   = y + dir.dy;
    const ni   = idx(nx, ny);
    const cell = cells[ni];

    switch (cell) {
      case G.UNTOUCHED: carveUntouched(dirIdx, x, y, nx, ny, ni, dir); break;
      case G.EMPTY:
        rec(x, y, nx, ny, `slide-empty (${nx-1},${ny-1})`);
        if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny);
        break;
      case G.CRUMBLE:
        if (currentActivatedSet.has(ni)) {
          rec(x, y, nx, ny, `slide-crumble-gone (${nx-1},${ny-1})`);
          if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny);
        } else {
          rec(x, y, nx, ny, `stopped-crumble (${nx-1},${ny-1})`);
          const ca = [...currentBranchActivated, ni].sort((a, b) => a - b);
          const cuk = ca.join(',');
          const bpk = `${cuk}|${x},${y}`;
          if (!branchPosSet.has(bpk)) { branchPosSet.add(bpk); branchQueue.push({ x, y, activated: ca }); }
        }
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
        if (allowedDir === dirIdx) {
          rec(x, y, nx, ny, `slide-oneway-allowed (${nx-1},${ny-1})`);
          carve(dirIdx, nx, ny);
        } else {
          rec(x, y, nx, ny, `stopped-oneway-blocked (${nx-1},${ny-1})`);
          enqueue(x, y);
        }
        break;
      }
      case G.KEY:
        if (currentActivatedSet.has(ni)) {
          rec(x, y, nx, ny, `slide-key-collected (${nx-1},${ny-1})`);
          if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny);
        } else {
          rec(x, y, nx, ny, `stopped-key (${nx-1},${ny-1})`);
          const ka = [...currentBranchActivated, ni].sort((a, b) => a - b);
          const kuk = ka.join(',');
          const bpk = `${kuk}|${nx},${ny}`;
          if (!branchPosSet.has(bpk)) { branchPosSet.add(bpk); branchQueue.push({ x: nx, y: ny, activated: ka }); }
        }
        break;
      case G.DOOR: {
        const keyPad = doorToKeyPaddedMap.get(ni);
        if (keyPad !== undefined && currentActivatedSet.has(keyPad)) {
          rec(x, y, nx, ny, `slide-door-open (${nx-1},${ny-1})`);
          if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny);
        } else {
          rec(x, y, nx, ny, `stopped-door-locked (${nx-1},${ny-1})`);
          enqueue(x, y);
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
  carve(3 /* DOWN */, startX, startY + 1);
  while (branchQueue.length > 0) {
    const { x, y, resumeDir, activated, initialVD } = branchQueue.shift();
    currentBranchActivated = activated ?? [];
    currentActivatedSet    = new Set(currentBranchActivated);
    currentUniverseKey     = currentBranchActivated.join(',');
    if (!universeVDs.has(currentUniverseKey)) {
      universeVDs.set(currentUniverseKey, initialVD ? new Map(initialVD) : new Map());
    }
    currentVD = universeVDs.get(currentUniverseKey);
    if (resumeDir !== undefined) {
      // Parallel universe branch: un-mark the direction in THIS universe's VD
      // so carve can slide through the now-passable cell.
      const ci = idx(x, y);
      currentVD.set(ci, (currentVD.get(ci) ?? 0) & ~(1 << resumeDir));
      carve(resumeDir, x, y);
    } else {
      rec(x, y, -1, -1, `▶ processing (${x-1},${y-1})  queue: ${branchQueue.length} remaining`);
      for (let i = 0; i < DIRS.length; i++) carve(i, x, y);
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
          out = dk !== undefined ? ONEWAY_OUT[dk] : 0;
          break;
        }
        case G.CRUMBLE: out = 7; break;   // CellType.CRUMBLE
        case G.KEY:     out = 8; break;   // CellType.KEY
        case G.DOOR:    out = 9; break;   // CellType.DOOR
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

  // Build doorRequirements from key-door pairs placed during carving.
  // Toggle indices must match what _findGoal's toggleMap assigns: sequential over
  // all CRUMBLE(7) and KEY(8) cells in flat scan order.
  const toggleMapForDoors = new Map();
  let tIdx = 0;
  for (let i = 0; i < outCells.length; i++) {
    if (outCells[i] === 7 || outCells[i] === 8) toggleMapForDoors.set(i, tIdx++);
  }
  const doorRequirements = new Map();
  for (const { keyI, doorI } of keyDoorPairs) {
    const kx = (keyI % pw) - 1, ky = Math.floor(keyI / pw) - 1;
    const dx = (doorI % pw) - 1, dy = Math.floor(doorI / pw) - 1;
    if (kx >= 0 && kx < width && ky >= 0 && ky < height && dx >= 0 && dx < width && dy >= 0 && dy < height) {
      const ti = toggleMapForDoors.get(ky * width + kx);
      if (ti !== undefined) doorRequirements.set(dy * width + dx, ti);
    }
  }

  const { goal, depths, difficulties, chainLengths, toggleCount, universeDepths, universeChainLengths } = _findGoal(outCells, width, height, start, doorRequirements, carvedMask);
  const goalDifficulty = difficulties[goal.y * width + goal.x];

  // Compute per-key cog depths and the effective gear budget.
  // The door may not gate the goal, so a key might sit deeper than the direct
  // path to the goal.  The player must have enough gears to reach every key,
  // otherwise a level with a key they can never collect produces a dead-end.
  const goalDepth = depths[goal.y * width + goal.x];
  const keyDepths = [];
  for (let i = 0; i < outCells.length; i++) {
    if (outCells[i] === 8) {
      keyDepths.push({ x: i % width, y: Math.floor(i / width), depth: depths[i] });
    }
  }
  const effectiveCogs = keyDepths.reduce(
    (max, k) => Math.max(max, k.depth >= 0 ? k.depth : 0),
    goalDepth >= 0 ? goalDepth : 0
  );

  // Compute effective chain length budget: max of chain length to goal and to every key.
  const goalChainLength = chainLengths[goal.y * width + goal.x];
  const effectiveChainLength = keyDepths.reduce(
    (max, k) => Math.max(max, chainLengths[k.y * width + k.x] >= 0 ? chainLengths[k.y * width + k.x] : 0),
    goalChainLength >= 0 ? goalChainLength : 0
  );

  // Translate base-universe visitedDirs from padded indices → unpadded flat indices for export
  const visitedDirsOut = new Map();
  for (const [pi, bits] of (universeVDs.get('') ?? [])) {
    const px = pi % pw, py = Math.floor(pi / pw);
    if (px >= 1 && px < pw - 1 && py >= 1 && py < ph - 1) {
      visitedDirsOut.set((py - 1) * width + (px - 1), dirBitsToSet(bits));
    }
  }

  return { id, width, height, cells: outCells, start, goal, depths, difficulties, goalDifficulty, goalDepth, keyDepths, effectiveCogs, chainLengths, effectiveChainLength, doorRequirements, seed, visitedDirs: visitedDirsOut, toggleCount, universeDepths, universeChainLengths };
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
  let blockedByOneway  = null; // {x, y} of the oneway cell if blocked, else null
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
      blockedByOneway = { x: nx, y: ny };                              // ONEWAY wrong dir
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
          out = dk !== undefined ? ONEWAY_OUT[dk] : 0;
          break;
        }
        case 5: out = 7; break; // G.CRUMBLE → CellType.CRUMBLE
        case 6: out = 8; break; // G.KEY     → CellType.KEY
        case 7: out = 9; break; // G.DOOR    → CellType.DOOR
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

  // ── Pass 1: BFS for gear depths ──────────────────────────────────────────
  // depths tracks the minimum *gear* cost at which a cell is reachable.
  // Gear cost = minimum number of unique-new landing positions that must be
  // visited from the start to reach this cell.  For most moves this equals
  // slide count, but crumble-and-backtrack sequences break the equality:
  // a player can break a crumble and immediately return to their source
  // position for 0 net gears, so those crumble stops do not inflate the
  // budget.  The "free-backtrack" enqueue below handles this case.
  const landingVisited  = new Map();
  const depths          = new Map();

  // Per-universe tracking: ws → Map<posKey, value>
  const uDepths    = new Map();
  const uChainLens = new Map();
  const _recUD  = (ws, k, d) => { let m = uDepths.get(ws);    if (!m) { m = new Map(); uDepths.set(ws, m); }    if ((m.get(k) ?? Infinity) > d) m.set(k, d); };
  const _recUCL = (ws, k, v) => { let m = uChainLens.get(ws); if (!m) { m = new Map(); uChainLens.set(ws, m); } if ((m.get(k) ?? Infinity) > v) m.set(k, v); };

  // Parent-pointer tables for path-crossing detection (added after BFS completes).
  // parentOf     : stateKey → { fromKey, landing: {x,y} }
  // bestKeyForPos: posFlat  → stateKey at minimum depth (in-grid cells only)
  const parentOf      = new Map();
  const bestKeyForPos = new Map();

  const startKey = stateKey(start, 3, 0);
  parentOf.set(startKey, { fromKey: null, landing: start });

  landingVisited.set(stateKey(start, 3, 0), 0);
  depths.set(posKey(start), 0);
  _recUD(0, posKey(start), 0);
  _recUCL(0, posKey(start), 0);
  // 0-1 BFS: bfsCurr holds nodes at the current bend-depth, bfsNext at current+1.
  // 0-cost (same direction) → push to bfsCurr; 1-cost (bend) → push to bfsNext.
  let bfsCurr = [{ pos: start, depth: 0, worldState: 0, di: 3 }];
  let bfsNext = [];
  let currHead = 0;

  // Walk the parentOf chain from fromStateKey upward, adding a free-backtrack
  // node at every ancestor with newWorldState at the ancestor's original depth.
  // This models the player collecting a toggle (key/crumble) and retracting their
  // entire departure-cog chain back to any prior waypoint for 0 net gears.
  function _propagateFreeBacktrack(fromStateKey, newWorldState) {
    let curKey = fromStateKey;
    while (curKey !== null && curKey !== undefined) {
      const entry = parentOf.get(curKey);
      if (!entry) break;
      const ancPos   = entry.landing;
      const ancDi    = ((curKey % 5) + 5) % 5;
      const ancDepth = landingVisited.get(curKey);
      if (ancDepth === undefined) break;
      const freeKey = stateKey(ancPos, ancDi, newWorldState);
      if ((landingVisited.get(freeKey) ?? Infinity) > ancDepth) {
        landingVisited.set(freeKey, ancDepth);
        parentOf.set(freeKey, { fromKey: curKey, landing: ancPos });
        const pk = posKey(ancPos);
        if (!bestKeyForPos.has(pk)) bestKeyForPos.set(pk, freeKey);
        bfsCurr.push({ pos: ancPos, depth: ancDepth, worldState: newWorldState, di: ancDi });
        if (ancPos.y >= 0) _recUD(newWorldState, pk, ancDepth);
      }
      curKey = entry.fromKey;
    }
  }

  while (currHead < bfsCurr.length || bfsNext.length > 0) {
    if (currHead >= bfsCurr.length) {
      bfsCurr = bfsNext; bfsNext = []; currHead = 0;
    }
    const { pos, depth, worldState, di } = bfsCurr[currHead++];

    if ((landingVisited.get(stateKey(pos, di, worldState)) ?? depth) < depth) continue;

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];
      const { path, crumblePos, keyPos, blockedByOneway } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements);

      // A reversal (moving exactly opposite the arrival direction) is a free retraction —
      // the pending cog at the current position retracts with the player.
      const isReversal = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;

      // Skip unproductive slides, but allow reversal-blocked-by-oneway through
      // so we can generate the free-backtrack transition below.
      if (path.length === 0 && !crumblePos && !(isReversal && blockedByOneway)) continue;

      // Reversals are free; all other direction changes cost one gear.
      const isBendMove = (i !== di) && !isReversal;
      const nd = depth + (isBendMove ? 1 : 0);

      // Set depth for every cell reached on this slide.
      for (const p of path) {
        const k = posKey(p);
        if (!depths.has(k) || depths.get(k) > nd) depths.set(k, nd);
        _recUD(worldState, k, nd);
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
          (isBendMove ? bfsNext : bfsCurr).push({ pos: landing, depth: nd, worldState: effectiveWS, di: i });
        }
        // Key landing: record the landing cell in the universe AFTER key collection too.
        if (keyPos) _recUD(effectiveWS, posKey(landing), nd);
      }

      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk   = posKey(from);
        // Zero-move crumble bounce: the game's pending-cog-pop immediately refunds
        // the gear placed for any bend and resets prevDir to the approach direction (di).
        // So a zero-move bounce costs 0 gears and the effective direction stays di.
        const crumbleNd = path.length === 0 ? depth : nd;
        const crumbleDi = path.length === 0 ? di : i;
        if (!depths.has(fk) || depths.get(fk) > crumbleNd) depths.set(fk, crumbleNd);
        _recUD(newWorldState, fk, crumbleNd);
        const lk = stateKey(from, crumbleDi, newWorldState);
        if ((landingVisited.get(lk) ?? Infinity) > crumbleNd) {
          landingVisited.set(lk, crumbleNd);
          parentOf.set(lk, { fromKey: stateKey(pos, di, worldState), landing: from });
          const pf = posKey(from);
          if (!bestKeyForPos.has(pf)) bestKeyForPos.set(pf, lk);
          (crumbleDi !== di ? bfsNext : bfsCurr).push({ pos: from, depth: crumbleNd, worldState: newWorldState, di: crumbleDi });
        }

        // "Free-backtrack" variant: the player can break the crumble and retract
        // their entire departure-cog chain back to any prior waypoint for 0 net
        // gears.  Propagate the new worldState to pos AND all its ancestors.
        _propagateFreeBacktrack(stateKey(pos, di, worldState), newWorldState);
      }

      // "Free-backtrack via key": collect the key and retract the entire
      // departure-cog chain back to any prior waypoint for 0 net gears.
      if (keyPos && keyPos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << keyPos.toggleIdx);
        _propagateFreeBacktrack(stateKey(pos, di, worldState), newWorldState);
      }

      // "Free-backtrack via one-way" variant: the player slid in the reversal direction,
      // hit a one-way they can't pass backward, and the game backtracks them to the origin
      // of the segment (the parent BFS node).  This costs 0 extra gears and leaves the
      // player at the parent position with the same incoming direction as before, mirroring
      // how game.js sets prevDir after _executeBacktrack.
      if (isReversal && blockedByOneway && path.length === 0) {
        const parentInfo = parentOf.get(stateKey(pos, di, worldState));
        if (parentInfo && (parentInfo.landing.x !== pos.x || parentInfo.landing.y !== pos.y)) {
          const backPos = parentInfo.landing;
          const freeKey = stateKey(backPos, di, worldState);
          if ((landingVisited.get(freeKey) ?? Infinity) > nd) {
            landingVisited.set(freeKey, nd);
            parentOf.set(freeKey, { fromKey: stateKey(pos, di, worldState), landing: backPos });
            const pf = posKey(backPos);
            if (!bestKeyForPos.has(pf)) bestKeyForPos.set(pf, freeKey);
            bfsCurr.push({ pos: backPos, depth: nd, worldState, di });
          }
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

  // ── Pass 3: Dijkstra for minimum chain length to reach each cell ──────
  // Cost per edge = path.length (cells traveled in this slide).
  const clLenMap = new Map();
  const clVisMap = new Map();
  clLenMap.set(posKey(start), 0);
  clVisMap.set(stateKey(start, 4, 0), 0);
  const clHeap = [{ pos: start, cl: 0, worldState: 0, di: 4 }];
  function clPush(e) {
    clHeap.push(e); let i = clHeap.length - 1;
    while (i > 0) { const p = (i-1)>>1; if (clHeap[p].cl <= clHeap[i].cl) break; [clHeap[p],clHeap[i]]=[clHeap[i],clHeap[p]]; i=p; }
  }
  function clPop() {
    const top = clHeap[0], last = clHeap.pop();
    if (clHeap.length > 0) {
      clHeap[0] = last; let i = 0;
      while (true) { let s=i; const l=2*i+1,r=2*i+2; if(l<clHeap.length&&clHeap[l].cl<clHeap[s].cl)s=l; if(r<clHeap.length&&clHeap[r].cl<clHeap[s].cl)s=r; if(s===i)break; [clHeap[i],clHeap[s]]=[clHeap[s],clHeap[i]]; i=s; }
    }
    return top;
  }
  while (clHeap.length > 0) {
    const { pos, cl, worldState, di } = clPop();
    if ((clVisMap.get(stateKey(pos, di, worldState)) ?? Infinity) < cl) continue;
    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];
      const { path, crumblePos, keyPos } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements);
      if (path.length === 0 && !crumblePos) continue;
      const nCl = cl + path.length;
      for (const p of path) {
        const k = posKey(p);
        if (!clLenMap.has(k) || clLenMap.get(k) > nCl) clLenMap.set(k, nCl);
        _recUCL(worldState, k, nCl);
      }
      if (path.length > 0) {
        const landing = path[path.length - 1];
        const ews = keyPos ? (worldState | (1 << keyPos.toggleIdx)) : worldState;
        const lk = stateKey(landing, i, ews);
        if ((clVisMap.get(lk) ?? Infinity) > nCl) { clVisMap.set(lk, nCl); clPush({ pos: landing, cl: nCl, worldState: ews, di: i }); }
        if (keyPos) _recUCL(ews, posKey(landing), nCl);
      }
      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const nws = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk = posKey(from);
        if (!clLenMap.has(fk) || clLenMap.get(fk) > nCl) clLenMap.set(fk, nCl);
        _recUCL(nws, fk, nCl);
        const lk = stateKey(from, i, nws);
        if ((clVisMap.get(lk) ?? Infinity) > nCl) { clVisMap.set(lk, nCl); clPush({ pos: from, cl: nCl, worldState: nws, di: i }); }
      }
    }
  }

  // ── Build flat arrays: -1 = unreachable ──────────────────────────────────
  const depthArray       = new Int16Array(width * height).fill(-1);
  const difficultyArray  = new Float32Array(width * height).fill(-1);
  const chainLengthArray = new Int16Array(width * height).fill(-1);
  for (const [k, d] of depths)       depthArray[k]       = d;
  for (const [k, d] of difficulties) difficultyArray[k]  = d;
  for (const [k, v] of clLenMap)     chainLengthArray[k] = v;

  // ── Per-universe arrays: one Int16Array per worldState ───────────────────
  // universeDepths[ws][flatIdx]       = min gear depth in universe ws, -1 = unreachable
  // universeChainLengths[ws][flatIdx] = min chain length in universe ws, -1 = unreachable
  const universeCount        = 1 << toggleCount;
  const universeDepths       = Array.from({ length: universeCount }, (_, ws) => {
    const arr = new Int16Array(width * height).fill(-1);
    const m = uDepths.get(ws);
    if (m) for (const [k, d] of m) arr[k] = d;
    return arr;
  });
  const universeChainLengths = Array.from({ length: universeCount }, (_, ws) => {
    const arr = new Int16Array(width * height).fill(-1);
    const m = uChainLens.get(ws);
    if (m) for (const [k, v] of m) arr[k] = v;
    return arr;
  });

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

  return { goal: bestPos, depths: depthArray, difficulties: difficultyArray, chainLengths: chainLengthArray,
           toggleCount, universeDepths, universeChainLengths };
}

