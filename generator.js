import { makeRng } from './random.js';
import { slidePlayer, buildToggleMap } from './puzzle.js';

// ── Internal generator cell values ──────────────────────────────────────────
const G = { UNTOUCHED: 0, EMPTY: 1, STICKY: 2, BLOCK: 3, ONEWAY: 4, CRUMBLE: 5, KEY: 6, DOOR: 7, TELEPORTER: 8 };

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
  TELEPORT:        2.0,   // passing through a teleporter (spatial disorientation)
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
export function generateLevel(width, height, { seed = 0, id = 1, weights = WEIGHTS, useKeyDoor = true, useTeleporter = false, _steps = null, entrySlide = null, playerGears = Infinity, playerChainLength = Infinity } = {}) {
  const rng = makeRng(seed);
  // Sync the 'key' weight with useKeyDoor: inject a default if missing when enabled,
  // strip it if present when disabled — so pickType() and useKeyDoor always agree.
  if (useKeyDoor && !('key' in weights)) weights = { ...weights, key: 0.05 };
  else if (!useKeyDoor && 'key' in weights) { weights = { ...weights }; delete weights.key; }
  if (useTeleporter && !('teleporter' in weights)) weights = { ...weights, teleporter: 0.06 };
  else if (!useTeleporter && 'teleporter' in weights) { weights = { ...weights }; delete weights.teleporter; }
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

  // ── Forced entry-slide block (tutorial / mechanic introduction) ──
  // Place a specific block type at a chosen distance in the entry column
  // before the BFS carver runs, so it is treated as its native type.
  // All cells between the second tunnel cell and the block are forced to
  // EMPTY so the player always slides through them and reaches the block.
  if (entrySlide) {
    const type = typeof entrySlide === 'string' ? entrySlide : entrySlide.type;
    let dist;
    if (entrySlide.dist !== undefined) {
      dist = entrySlide.dist;
    } else if (entrySlide.minDist !== undefined) {
      dist = entrySlide.minDist + Math.floor(rng() * (entrySlide.maxDist - entrySlide.minDist + 1));
    } else {
      dist = 3;
    }
    // dist is 1-indexed from the boat: dist=1 → grid y=0 (padded y=startY).
    // Minimum 2 preserves the always-passthrough cell at startY.
    dist = Math.max(2, Math.min(dist, height));
    const ey = startY + (dist - 1);  // padded y-coordinate
    if (ey < ph - 1) {
      const typeToG = { sticky: G.STICKY, crumble: G.CRUMBLE, block: G.BLOCK };
      const gType = typeToG[type];
      if (gType !== undefined) {
        // Force all intermediate entry-column cells to EMPTY so the player slides through.
        for (let ey2 = startY + 2; ey2 < ey; ey2++) cells[idx(startX, ey2)] = G.EMPTY;
        cells[idx(startX, ey)] = gType;
      }
    }
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
  const paddedTeleporterMap = new Map(); // padded flat idx ↔ padded flat idx
  let   hasTeleporter    = false;
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
      allUniverseVDs.set(k, new Map(vd));
    }
    // Also surface universes that are queued but not yet dequeued — universeVDs
    // only gets an entry on dequeue, so without this new panels wouldn't appear
    // until the branch is actually processed.
    for (const item of branchQueue) {
      const uKey = (item.activated ?? []).join(',');
      if (!allUniverseVDs.has(uKey)) {
        allUniverseVDs.set(uKey, item.initialVD ? new Map(item.initialVD) : new Map());
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
    _steps.push({ grid: new Uint8Array(cells), onewayDir: new Map(onewayDir), allUniverseVDs, frontier, doorFrontier, currentUniverseKey, pw, ph, fromX, fromY, toX, toY, label, activated: currentBranchActivated.slice(), teleporterPairs: paddedTeleporterMap.size > 0 ? new Map(paddedTeleporterMap) : null });
  }

  // Find a valid teleporter exit: an already-carved G.EMPTY cell far enough from (entryPX,entryPY),
  // with no BLOCK neighbors (so the player can approach/exit from any direction).
  // All inner (non-border) orthogonal neighbors of (pX, pY) must be G.EMPTY or G.STICKY.
  // Border neighbors (at the padded-grid edge) are always G.BLOCK — skip them.
  function hasOnlyOpenNeighbors(pX, pY) {
    for (const d of DIRS) {
      const nx = pX + d.dx, ny = pY + d.dy;
      if (nx < 1 || nx >= pw - 1 || ny < 1 || ny >= ph - 1) return false; // adjacent to border — reject
      const c = cells[idx(nx, ny)];
      if (c !== G.EMPTY && c !== G.STICKY && c !== G.UNTOUCHED) return false;
    }
    return true;
  }

  // Convert any UNTOUCHED neighbors of a teleporter cell to EMPTY so nothing else can be placed there.
  function sealTeleporterNeighbors(pX, pY) {
    for (const d of DIRS) {
      const nx = pX + d.dx, ny = pY + d.dy;
      if (nx < 1 || nx >= pw - 1 || ny < 1 || ny >= ph - 1) continue;
      if (cells[idx(nx, ny)] === G.UNTOUCHED) cells[idx(nx, ny)] = G.EMPTY;
    }
  }

  // Find a valid teleporter exit: an UNTOUCHED cell far enough from (entryPX, entryPY)
  // whose inner neighbors are all G.EMPTY or G.STICKY.
  function findTeleporterExit(entryPX, entryPY) {
    const candidates = [];
    for (let py2 = startY + 1; py2 < ph - 1; py2++) {
      for (let px2 = 1; px2 < pw - 1; px2++) {
        if (Math.abs(px2 - entryPX) + Math.abs(py2 - entryPY) < 4) continue;
        const ni2 = idx(px2, py2);
        if (cells[ni2] !== G.UNTOUCHED) continue;           // must be untouched
        if (px2 === startX && py2 <= startY + 1) continue;  // keep entry tunnel clear
        if (!hasOnlyOpenNeighbors(px2, py2)) continue;
        candidates.push(ni2);
      }
    }
    if (!candidates.length) return null;
    return candidates[Math.floor(rng() * candidates.length)];
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
    } else if (type === 'teleporter') {
      if (useTeleporter && !hasTeleporter && hasOnlyOpenNeighbors(nx, ny)) {
        const exitNi = findTeleporterExit(nx, ny);
        if (exitNi !== null) {
          const ex = exitNi % pw, ey = Math.floor(exitNi / pw);
          cells[ni] = G.TELEPORTER;
          cells[exitNi] = G.TELEPORTER;
          paddedTeleporterMap.set(ni, exitNi);
          paddedTeleporterMap.set(exitNi, ni);
          hasTeleporter = true;
          sealTeleporterNeighbors(nx, ny);
          sealTeleporterNeighbors(ex, ey);
          rec(x, y, nx, ny, `teleporter (${nx-1},${ny-1}) ↔ (${ex-1},${ey-1})`);
          // Player slides through the entry and emerges at the exit.
          // Mark the entry as visited so it's not re-entered from this direction,
          // then continue carving from the exit in the same direction.
          markVisited(ni, dirIdx);
          if (!hasVisited(exitNi, dirIdx)) carve(dirIdx, ex, ey);
        } else {
          cells[ni] = G.EMPTY;
          rec(x, y, nx, ny, `empty (${nx-1},${ny-1})`);
          carve(dirIdx, nx, ny);
        }
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
      case G.TELEPORTER: {
        const exitNi = paddedTeleporterMap.get(ni);
        if (exitNi !== undefined && !hasVisited(exitNi, dirIdx)) {
          const ex = exitNi % pw, ey = Math.floor(exitNi / pw);
          rec(x, y, nx, ny, `slide-teleporter (${nx-1},${ny-1}) → (${ex-1},${ey-1})`);
          carve(dirIdx, ex, ey);
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
        case G.CRUMBLE:    out = 7;  break;   // CellType.CRUMBLE
        case G.KEY:        out = 8;  break;   // CellType.KEY
        case G.DOOR:       out = 9;  break;   // CellType.DOOR
        case G.BLOCK:      out = 1;  break;   // CellType.WALL
        case G.TELEPORTER: out = 10; break;   // CellType.TELEPORTER
        default:           out = 0;  break;   // CellType.EMPTY  (UNTOUCHED — never carved)
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

  // Fallback: if useTeleporter but the BFS weight never fired (early or unlucky),
  // place a teleporter pair now in `cells` and record a final step for it.
  if (useTeleporter && !hasTeleporter) {
    const candidates = [];
    for (let py2 = startY + 1; py2 < ph - 1; py2++) {
      for (let px2 = 1; px2 < pw - 1; px2++) {
        if (px2 === startX && py2 <= startY + 1) continue;
        const ni2 = idx(px2, py2);
        if (cells[ni2] === G.UNTOUCHED && hasOnlyOpenNeighbors(px2, py2)) candidates.push(ni2);
      }
    }
    for (let attempt = 0; attempt < 200 && candidates.length >= 2; attempt++) {
      const i1 = Math.floor(rng() * candidates.length);
      let   i2 = Math.floor(rng() * (candidates.length - 1));
      if (i2 >= i1) i2++;
      const ni1 = candidates[i1], ni2 = candidates[i2];
      const px1 = ni1 % pw, py1 = Math.floor(ni1 / pw);
      const px2 = ni2 % pw, py2 = Math.floor(ni2 / pw);
      if (Math.abs(px1 - px2) + Math.abs(py1 - py2) < 4) continue;
      cells[ni1] = G.TELEPORTER;
      cells[ni2] = G.TELEPORTER;
      outCells[(py1 - 1) * width + (px1 - 1)] = 10;
      outCells[(py2 - 1) * width + (px2 - 1)] = 10;
      sealTeleporterNeighbors(px1, py1);
      sealTeleporterNeighbors(px2, py2);
      paddedTeleporterMap.set(ni1, ni2);
      paddedTeleporterMap.set(ni2, ni1);
      hasTeleporter = true;
      rec(-1, -1, px1, py1, `teleporter-fallback (${px1-1},${py1-1}) ↔ (${px2-1},${py2-1})`);
      break;
    }
  }

  // Build output teleporterMap from padded indices.
  let teleporterMap = null;
  if (paddedTeleporterMap.size > 0) {
    teleporterMap = new Map();
    for (const [pni1, pni2] of paddedTeleporterMap) {
      const ox1 = (pni1 % pw) - 1, oy1 = Math.floor(pni1 / pw) - 1;
      const ox2 = (pni2 % pw) - 1, oy2 = Math.floor(pni2 / pw) - 1;
      if (ox1 >= 0 && ox1 < width && oy1 >= 0 && oy1 < height &&
          ox2 >= 0 && ox2 < width && oy2 >= 0 && oy2 < height) {
        teleporterMap.set(oy1 * width + ox1, oy2 * width + ox2);
      }
    }
  }

  const { goal, depths, difficulties, chainLengths, chainOnGearLengths, gearsOnChainDepths,
          p4BestAtPos, toggleCount, universeDepths, universeChainLengths, solution } =
    _findGoal(outCells, width, height, start, doorRequirements, carvedMask, teleporterMap, playerGears, playerChainLength);
  const goalDifficulty = difficulties[goal.y * width + goal.x];

  const goalFlat  = goal.y * width + goal.x;
  const goalDepth = depths[goalFlat];
  const keyDepths = [];
  for (let i = 0; i < outCells.length; i++) {
    if (outCells[i] === 8) {
      keyDepths.push({ x: i % width, y: Math.floor(i / width), depth: depths[i] });
    }
  }

  const goalChainLength = chainLengths[goalFlat];

  // ── Companion pair selection ──────────────────────────────────────────────
  // Pass 1 gives the min-gear path; Pass 3 gives the min-chain path.
  // Both are real paths but may use different amounts of the other resource.
  // Pair A = (min_gears, chain_on_that_path); Pair B = (gears_on_min_chain_path, min_chain).
  // Taking max over goal + all required keys ensures every needed cell is reachable.
  const _maxOver = (baseVal, arr) => keyDepths.reduce(
    (m, k) => { const v = arr[k.y * width + k.x]; return Math.max(m, v >= 0 ? v : 0); },
    baseVal >= 0 ? baseVal : 0
  );
  const pairA_gears = _maxOver(goalDepth,                    depths);
  const pairA_chain = _maxOver(chainOnGearLengths[goalFlat], chainOnGearLengths);
  const pairB_gears = _maxOver(gearsOnChainDepths[goalFlat], gearsOnChainDepths);
  const pairB_chain = _maxOver(goalChainLength,              chainLengths);

  // Each pair is a valid (gears, chain) budget — it corresponds to a real path.
  // Pair C comes from Pass 4 and is guaranteed valid when Pass 4 ran (both values ≤ player stats).
  // Filter A/B by player stats (Infinity = no constraint), then pick the tightest valid pair.
  const pg = playerGears;
  const pc = playerChainLength;

  const p4Goal   = p4BestAtPos?.get(goalFlat);  // null when !hasBudgets
  const pairC    = p4Goal ? { g: p4Goal.g, c: p4Goal.chain } : null;

  const candidates = [
    (pairA_gears <= pg && pairA_chain <= pc) ? { g: pairA_gears, c: pairA_chain } : null,
    (pairB_gears <= pg && pairB_chain <= pc) ? { g: pairB_gears, c: pairB_chain } : null,
    pairC,
  ].filter(Boolean);

  let effectiveCogs, effectiveChainLength;
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (a.g + a.c <= b.g + b.c ? a : b));
    effectiveCogs = best.g; effectiveChainLength = best.c;
  } else {
    // Only reachable when !hasBudgets — A and B are always valid with Infinity constraints.
    effectiveCogs = pairA_gears; effectiveChainLength = pairB_chain;
  }

  // Guarantee the budget is always sufficient to physically reach every key cell.
  // The tightest pair may use fewer gears/chain than the key requires (e.g. when the
  // goal path retracts chain after the key, or when a low-gear path to the goal
  // doesn't reflect the min gears needed just to reach the key).
  for (const kd of keyDepths) {
    const kFlat = kd.y * width + kd.x;
    if (depths[kFlat]       >= 0) effectiveCogs         = Math.max(effectiveCogs,         depths[kFlat]);
    if (chainLengths[kFlat] >= 0) effectiveChainLength  = Math.max(effectiveChainLength,  chainLengths[kFlat]);
  }

  // Translate base-universe visitedDirs from padded indices → unpadded flat indices for export
  const visitedDirsOut = new Map();
  for (const [pi, bits] of (universeVDs.get('') ?? [])) {
    const px = pi % pw, py = Math.floor(pi / pw);
    if (px >= 1 && px < pw - 1 && py >= 1 && py < ph - 1) {
      visitedDirsOut.set((py - 1) * width + (px - 1), dirBitsToSet(bits));
    }
  }

  return { id, width, height, cells: outCells, start, goal, depths, difficulties, goalDifficulty, goalDepth, keyDepths, effectiveCogs, chainLengths, effectiveChainLength, doorRequirements, teleporterMap, seed, visitedDirs: visitedDirsOut, toggleCount, universeDepths, universeChainLengths, useKeyDoor, solution };
}

/**
 * Generate `candidates` levels (consecutive seeds) and return the hardest one
 * (highest goal difficulty — most cognitively demanding path to the goal).
 *
 * @param {number} width
 * @param {number} height
 * @param {{ seed?: number, id?: number|string, candidates?: number }} [opts]
 */
export function generateHardestLevel(width, height, { seed = 0, id = 1, candidates = 300, weights = WEIGHTS, useKeyDoor = true, useTeleporter = false, difficultyTarget = null, entrySlide = null, playerGears = Infinity, playerChainLength = Infinity } = {}) {
  let best      = null;
  let bestScore = Infinity;

  for (let i = 0; i < candidates; i++) {
    const level = generateLevel(width, height, { seed: seed + i, id, weights, useKeyDoor, useTeleporter, entrySlide, playerGears, playerChainLength });
    const d = level.goalDifficulty;
    const score = difficultyTarget !== null ? Math.abs(d - difficultyTarget) : -d;

    if (score < bestScore) {
      bestScore = score;
      best      = level;
      if (difficultyTarget !== null && bestScore < 0.5) break;
    }
  }

  const label = difficultyTarget !== null
    ? `target=${difficultyTarget}  closest=${best.goalDifficulty.toFixed(2)}`
    : `goalDifficulty=${best.goalDifficulty.toFixed(2)}`;
  best.weights       = weights;
  best.useKeyDoor    = useKeyDoor;
  best.useTeleporter = useTeleporter;
  return best;
}

// ── Debug logging ─────────────────────────────────────────────────────────────

function _logLevel(cells, width, height, start, goal, id, goalDifficulty) {
  const GLYPHS = ['.', '#', 'S', '←', '→', '↑', '↓', '░', 'K', 'D', 'T'];

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
function _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements = null, teleporterMap = null, gearSet = null) {
  const path = [];
  let x = pos.x, y = pos.y;
  let blockedByOneway  = null; // {x, y} of the oneway cell if blocked, else null
  let blockedByCrumble = false;
  let blockedByDoor    = false;
  let crumblePos       = null;
  let keyPos           = null;
  let teleportSeen     = null; // Set of entry flatIdx — prevents infinite loops (T1→T2→T1→…)

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

    // ── TELEPORTER: enter entry, jump to exit, continue sliding ──────────────
    if (cell === 10 && teleporterMap) {
      if (!teleportSeen) teleportSeen = new Set();
      if (teleportSeen.has(flatIdx)) break;                           // loop guard
      teleportSeen.add(flatIdx);
      x = nx; y = ny;
      path.push({ x, y, cell });
      const exitFlat = teleporterMap.get(flatIdx);
      if (exitFlat !== undefined) {
        x = exitFlat % width;
        y = Math.floor(exitFlat / width);
        const exitCell = cells[exitFlat];
        if (exitCell === 2) { path.push({ x, y, cell: exitCell }); break; }  // sticky exit
        if (gearSet && gearSet.has(exitFlat)) { path.push({ x, y, cell: exitCell }); break; }
        continue;                                                      // continue from exit
      }
      break;                                                           // no exit — stop at entry
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
    if (cell === 10)            cost += DIFFICULTY_WEIGHTS.TELEPORT;
  }
  if (blockedByOneway)  cost += DIFFICULTY_WEIGHTS.ONEWAY_BLOCKED;
  if (blockedByCrumble) cost += DIFFICULTY_WEIGHTS.CRUMBLE;
  if (blockedByDoor)    cost += DIFFICULTY_WEIGHTS.DOOR_LOCKED;

  return { path, cost, crumblePos, keyPos };
}
export { _slidePath as slidePath };

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


// Returns true if placing a teleporter pair at (x1,y1)↔(x2,y2) is safe:
// for every direction D, if the cell behind T can be approached from -D, then
// the cell one step past the partner in direction D must be non-wall and in-bounds.
function _isTeleporterPairValid(cells, width, height, x1, y1, x2, y2) {
  const DIRS4 = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  for (const { dx, dy } of DIRS4) {
    // Can the player approach T1 moving in direction (dx,dy)? (i.e. non-wall behind T1)
    const ax1 = x1 - dx, ay1 = y1 - dy;
    if (ax1 >= 0 && ax1 < width && ay1 >= 0 && ay1 < height
        && cells[ay1 * width + ax1] !== 1) {
      const ex2 = x2 + dx, ey2 = y2 + dy;
      if (ex2 < 0 || ex2 >= width || ey2 < 0 || ey2 >= height) return false;
      if (cells[ey2 * width + ex2] === 1) return false;
    }
    // Can the player approach T2 moving in direction (dx,dy)?
    const ax2 = x2 - dx, ay2 = y2 - dy;
    if (ax2 >= 0 && ax2 < width && ay2 >= 0 && ay2 < height
        && cells[ay2 * width + ax2] !== 1) {
      const ex1 = x1 + dx, ey1 = y1 + dy;
      if (ex1 < 0 || ex1 >= width || ey1 < 0 || ey1 >= height) return false;
      if (cells[ey1 * width + ex1] === 1) return false;
    }
  }
  return true;
}

// Post-processing: pick two carved EMPTY cells for a teleporter pair.
// Modifies outCells in place and returns a teleporterMap, or null if no valid pair found.
function _placeTeleporters(outCells, width, height, carvedMask, start, rng) {
  const candidates = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fi = y * width + x;
      if (!carvedMask[fi]) continue;
      if (outCells[fi] !== 0) continue;
      if (x === start.x && y <= 1) continue; // keep entry tunnel clear
      candidates.push(fi);
    }
  }
  if (candidates.length < 2) return null;

  for (let attempt = 0; attempt < 200; attempt++) {
    const i1 = Math.floor(rng() * candidates.length);
    let   i2 = Math.floor(rng() * (candidates.length - 1));
    if (i2 >= i1) i2++;
    const fi1 = candidates[i1], fi2 = candidates[i2];
    const x1 = fi1 % width, y1 = Math.floor(fi1 / width);
    const x2 = fi2 % width, y2 = Math.floor(fi2 / width);
    if (Math.abs(x1 - x2) + Math.abs(y1 - y2) < 4) continue;
    if (!_isTeleporterPairValid(outCells, width, height, x1, y1, x2, y2)) continue;

    // Every in-bounds orthogonal neighbor must be empty or untouched — any carved
    // non-empty cell (wall, door, etc.) risks stopping the player on the teleporter.
    const DIRS4 = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
    const allNeighborsOpen = (x, y) => DIRS4.every(({ dx, dy }) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return true;
      const nfi = ny * width + nx;
      return !carvedMask[nfi] || outCells[nfi] === 0;
    });
    if (!allNeighborsOpen(x1, y1) || !allNeighborsOpen(x2, y2)) continue;

    // Carve any untouched neighbors of both teleporters to empty so the player
    // always has a clear cell to slide into/out of.
    for (const [tx, ty] of [[x1, y1], [x2, y2]]) {
      for (const { dx, dy } of DIRS4) {
        const nx = tx + dx, ny = ty + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nfi = ny * width + nx;
        if (!carvedMask[nfi]) { outCells[nfi] = 0; carvedMask[nfi] = true; }
      }
    }

    outCells[fi1] = 10; // CellType.TELEPORTER
    outCells[fi2] = 10;
    const map = new Map([[fi1, fi2], [fi2, fi1]]);
    return map;
  }
  return null;
}

function _findGoal(cells, width, height, start, doorRequirements = null, carvedMask = null, teleporterMap = null, playerGears = Infinity, playerChainLength = Infinity) {
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
  // Companion value for Pass 1: for each cell, the chain length used on the min-gear path.
  const chainOnGearPath = new Map();

  // Update bestKeyForPos only when (newDepth, newChain) strictly dominates the current best.
  // Must be defined after landingVisited and parentOf are declared.
  const _setBestIfBetter = (pk, newKey, newDepth, newChain) => {
    const curBest = bestKeyForPos.get(pk);
    if (curBest === undefined) { bestKeyForPos.set(pk, newKey); return; }
    const curDepth = landingVisited.get(curBest) ?? Infinity;
    const curChain = parentOf.get(curBest)?.chain ?? Infinity;
    if (newDepth < curDepth || (newDepth === curDepth && newChain < curChain)) {
      bestKeyForPos.set(pk, newKey);
    }
  };

  const startKey = stateKey(start, 3, 0);
  parentOf.set(startKey, { fromKey: null, landing: start, chain: 0 });

  landingVisited.set(stateKey(start, 3, 0), 0);
  depths.set(posKey(start), 0);
  chainOnGearPath.set(posKey(start), 0);
  _recUD(0, posKey(start), 0);
  _recUCL(0, posKey(start), 0);
  // 0-1 BFS: bfsCurr holds nodes at the current bend-depth, bfsNext at current+1.
  // 0-cost (same direction) → push to bfsCurr; 1-cost (bend) → push to bfsNext.
  let bfsCurr = [{ pos: start, depth: 0, worldState: 0, di: 3, chain: 0 }];
  let bfsNext = [];
  let currHead = 0;

  // Walk the parentOf chain from fromStateKey upward, adding a free-backtrack
  // node at every ancestor with newWorldState at the ancestor's original depth.
  // This models the player collecting a toggle (key/crumble) and retracting their
  // entire departure-cog chain back to any prior waypoint for 0 net gears.
  //
  // keySlideDir : direction index (0-3) of the slide that activated the toggle.
  // triggerType : 'key' | 'crumble' — used by _reconstructSolution for path rebuilding.
  function _propagateFreeBacktrack(fromStateKey, newWorldState, keySlideDir = null, triggerType = 'key', isZeroMove = false) {
    let curKey = fromStateKey;
    while (curKey !== null && curKey !== undefined) {
      const entry = parentOf.get(curKey);
      if (!entry) break;
      const ancPos   = entry.landing;
      const ancDi    = ((curKey % 5) + 5) % 5;
      const ancDepth = landingVisited.get(curKey);
      const ancChain = entry.chain ?? 0;
      if (ancDepth === undefined) break;
      const freeKey = stateKey(ancPos, ancDi, newWorldState);
      if ((landingVisited.get(freeKey) ?? Infinity) > ancDepth) {
        landingVisited.set(freeKey, ancDepth);
        // isBacktrack/triggerKey/keySlideDir/triggerType/isZeroMove are used only by
        // _reconstructSolution for move-list reconstruction; they don't affect BFS.
        parentOf.set(freeKey, {
          fromKey: curKey, landing: ancPos, chain: ancChain,
          isBacktrack: true, triggerKey: fromStateKey, keySlideDir, triggerType, isZeroMove,
        });
        const pk = posKey(ancPos);
        _setBestIfBetter(pk, freeKey, ancDepth, ancChain);
        bfsCurr.push({ pos: ancPos, depth: ancDepth, worldState: newWorldState, di: ancDi, chain: ancChain });
        if (ancPos.y >= 0) _recUD(newWorldState, pk, ancDepth);
      }
      curKey = entry.fromKey;
    }
  }

  while (currHead < bfsCurr.length || bfsNext.length > 0) {
    if (currHead >= bfsCurr.length) {
      bfsCurr = bfsNext; bfsNext = []; currHead = 0;
    }
    const { pos, depth, worldState, di, chain } = bfsCurr[currHead++];

    if ((landingVisited.get(stateKey(pos, di, worldState)) ?? depth) < depth) continue;

    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];
      const { path, crumblePos, keyPos, blockedByOneway } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements, teleporterMap);

      // A reversal (moving exactly opposite the arrival direction) is a free retraction —
      // the pending cog at the current position retracts with the player.
      const isReversal = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;

      // Skip unproductive slides, but allow reversal-blocked-by-oneway through
      // so we can generate the free-backtrack transition below.
      if (path.length === 0 && !crumblePos && !(isReversal && blockedByOneway)) continue;

      // Reversals are free; all other direction changes cost one gear.
      const isBendMove = (i !== di) && !isReversal;
      const nd = depth + (isBendMove ? 1 : 0);

      // Set depth (and companion chain) for every cell reached on this slide.
      // Chain decreases only when a reversal is physically blocked by a one-way tile;
      // free reversals still add to chain to prevent infinite oscillation in the BFS.
      const chainRetracts = isReversal && blockedByOneway;
      for (let j = 0; j < path.length; j++) {
        const k = posKey(path[j]);
        const chainJ = chainRetracts ? chain - (j + 1) : chain + j + 1;
        if (!depths.has(k) || depths.get(k) > nd) {
          depths.set(k, nd);
          chainOnGearPath.set(k, chainJ);
        }
        _recUD(worldState, k, nd);
      }

      if (path.length > 0) {
        const landing    = path[path.length - 1];
        const newChain   = chainRetracts ? chain - path.length : chain + path.length;
        const effectiveWS = keyPos ? (worldState | (1 << keyPos.toggleIdx)) : worldState;
        const lk = stateKey(landing, i, effectiveWS);
        if ((landingVisited.get(lk) ?? Infinity) > nd) {
          landingVisited.set(lk, nd);
          parentOf.set(lk, { fromKey: stateKey(pos, di, worldState), landing, chain: newChain });
          const pf = posKey(landing);
          _setBestIfBetter(pf, lk, nd, newChain);
          (isBendMove ? bfsNext : bfsCurr).push({ pos: landing, depth: nd, worldState: effectiveWS, di: i, chain: newChain });
        }
        // Key landing: record the landing cell in the universe AFTER key collection too.
        if (keyPos) _recUD(effectiveWS, posKey(landing), nd);

        // Post-oneway exit node: when the slide passes through one or more one-way
        // tiles, add an extra exploration node at the cell immediately after the last
        // traversed one-way (with chain length at that intermediate position).  This
        // avoids over-counting chain when the player later explores perpendicular
        // directions from near the one-way rather than from the farther landing cell.
        if (!chainRetracts && path.length > 1) {
          let lastOWIdx = -1;
          for (let j = 0; j < path.length - 1; j++) {
            if (path[j].cell >= 3 && path[j].cell <= 6) lastOWIdx = j;
          }
          if (lastOWIdx >= 0 && lastOWIdx + 1 < path.length - 1) {
            const exitIdx   = lastOWIdx + 1;
            const exitCell  = path[exitIdx];
            const exitChain = chain + exitIdx + 1;
            const exitPk    = posKey(exitCell);
            const exitSK    = stateKey(exitCell, i, worldState);
            if ((landingVisited.get(exitSK) ?? Infinity) > nd) {
              landingVisited.set(exitSK, nd);
              parentOf.set(exitSK, { fromKey: stateKey(pos, di, worldState), landing: exitCell, chain: exitChain });
              _setBestIfBetter(exitPk, exitSK, nd, exitChain);
              if (!depths.has(exitPk) || depths.get(exitPk) > nd) depths.set(exitPk, nd);
              if (!chainOnGearPath.has(exitPk) || chainOnGearPath.get(exitPk) > exitChain) chainOnGearPath.set(exitPk, exitChain);
              _recUD(worldState, exitPk, nd);
              _recUCL(worldState, exitPk, exitChain);
              (isBendMove ? bfsNext : bfsCurr).push({ pos: exitCell, depth: nd, worldState, di: i, chain: exitChain });
            }
          }
        }
      }

      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk   = posKey(from);
        // Zero-move crumble bounce: the game's pending-cog-pop immediately refunds
        // the gear placed for any bend and resets prevDir to the approach direction (di).
        // So a zero-move bounce costs 0 gears and the effective direction stays di.
        const crumbleNd    = path.length === 0 ? depth : nd;
        const crumbleDi    = path.length === 0 ? di : i;
        const crumbleChain = chainRetracts ? chain - path.length : chain + path.length;
        if (!depths.has(fk) || depths.get(fk) > crumbleNd) {
          depths.set(fk, crumbleNd);
          chainOnGearPath.set(fk, crumbleChain);
        }
        _recUD(newWorldState, fk, crumbleNd);
        const lk = stateKey(from, crumbleDi, newWorldState);
        if ((landingVisited.get(lk) ?? Infinity) > crumbleNd) {
          landingVisited.set(lk, crumbleNd);
          parentOf.set(lk, { fromKey: stateKey(pos, di, worldState), landing: from, chain: crumbleChain, moveDir: i });
          const pf = posKey(from);
          _setBestIfBetter(pf, lk, crumbleNd, crumbleChain);
          (crumbleDi !== di ? bfsNext : bfsCurr).push({ pos: from, depth: crumbleNd, worldState: newWorldState, di: crumbleDi, chain: crumbleChain });
        }

        // "Free-backtrack" variant: the player can break the crumble and retract
        // their entire departure-cog chain back to any prior waypoint for 0 net
        // gears.  Propagate the new worldState to pos AND all its ancestors.
        // isZeroMove=true means path.length===0: player didn't move, just bounced.
        _propagateFreeBacktrack(stateKey(pos, di, worldState), newWorldState, i, 'crumble', path.length === 0);
      }

      // "Free-backtrack via key": collect the key and retract the entire
      // departure-cog chain back to any prior waypoint for 0 net gears.
      if (keyPos && keyPos.toggleIdx !== undefined) {
        const newWorldState = worldState | (1 << keyPos.toggleIdx);
        _propagateFreeBacktrack(stateKey(pos, di, worldState), newWorldState, i, 'key');
      }

      // "Free-backtrack via one-way" variant: the player slid in the reversal direction,
      // hit a one-way they can't pass backward, and the game backtracks them to the origin
      // of the segment (the parent BFS node).  This costs 0 extra gears and leaves the
      // player at the parent position with the same incoming direction as before, mirroring
      // how game.js sets prevDir after _executeBacktrack.
      // The chain RETRACTS to the parent's shorter value — hence backChain < chain.
      if (isReversal && blockedByOneway && path.length === 0) {
        const myEntry = parentOf.get(stateKey(pos, di, worldState));
        if (myEntry?.fromKey != null) {
          const parentEntry = parentOf.get(myEntry.fromKey);
          if (parentEntry) {
            const backPos   = parentEntry.landing;
            const backChain = parentEntry.chain ?? 0;
            if (backPos.x !== pos.x || backPos.y !== pos.y) {
              const freeKey = stateKey(backPos, di, worldState);
              if ((landingVisited.get(freeKey) ?? Infinity) > nd) {
                landingVisited.set(freeKey, nd);
                parentOf.set(freeKey, { fromKey: stateKey(pos, di, worldState), landing: backPos, chain: backChain });
                const pf = posKey(backPos);
                _setBestIfBetter(pf, freeKey, nd, backChain);
                bfsCurr.push({ pos: backPos, depth: nd, worldState, di, chain: backChain });
                if (backPos.y >= 0) _recUD(worldState, pf, nd);
              }
            }
          }
        }
      }
    }
  }

  // ── Solution reconstruction from Pass 1 parentOf tree ────────────────────
  // DIRS4 here matches _findGoal's local table: [LEFT, RIGHT, UP, DOWN] → indices 0-3.
  // di=3 (DOWN) is used for the initial start node (the dive from the boat).
  // We emit {dx,dy} objects so the ordering difference vs solver.js doesn't matter.
  const _DIRS4G = [{ dx:-1,dy:0 }, { dx:1,dy:0 }, { dx:0,dy:-1 }, { dx:0,dy:1 }];

  function _reconstructSolution(goalFlat) {
    const goalStateKey = bestKeyForPos.get(goalFlat);
    if (goalStateKey === undefined) return null;

    // Walk backward from goal, collecting arrival-direction indices.
    // Stop when we hit a free-backtrack node (key or crumble backtracking needed)
    // or reach the BFS root (fromKey === null).
    const goalDiSeq = [];
    let curKey = goalStateKey;
    let btEntry = null;

    while (true) {
      const entry = parentOf.get(curKey);
      if (!entry || entry.fromKey === null) break;
      if (entry.isBacktrack) { btEntry = entry; break; }
      const moveDi = entry.moveDir ?? curKey % 5;
      if (moveDi < 4) goalDiSeq.push(moveDi);
      curKey = entry.fromKey;
    }

    if (!btEntry) {
      // ── Simple case: no backtracking required ────────────────────────────
      goalDiSeq.reverse();
      return { moves: goalDiSeq.map(di => ({ dx: _DIRS4G[di].dx, dy: _DIRS4G[di].dy })) };
    }

    // ── Crumble phantom in the goal path ─────────────────────────────────
    // A zero-move bounce at pos flipped the worldState; the player stayed at pos
    // and continues to the goal in wsNew.  Reconstructible only for the first-level
    // phantom (fromKey === triggerKey, i.e. ancPos === pos) with no nested phantoms.
    // Non-zero bounces and deep ancestor phantoms fall back to Dijkstra.
    if (btEntry.triggerType === 'crumble') {
      if (!btEntry.isZeroMove || btEntry.fromKey !== btEntry.triggerKey) return null;

      // Collect the wsOld path from start to pos (= btEntry.fromKey = triggerKey).
      const preDiSeq = [];
      let cur = btEntry.fromKey;
      while (true) {
        const e = parentOf.get(cur);
        if (!e || e.fromKey === null) break;
        if (e.isBacktrack) return null; // nested phantom — give up
        const moveDi = e.moveDir ?? cur % 5;
        if (moveDi < 4) preDiSeq.push(moveDi);
        cur = e.fromKey;
      }
      preDiSeq.reverse();   // now forward: start → pos
      goalDiSeq.reverse();  // now forward: pos(wsNew) → goal
      const allDi = [...preDiSeq, btEntry.keySlideDir, ...goalDiSeq];
      return { moves: allDi.map(di => ({ dx: _DIRS4G[di].dx, dy: _DIRS4G[di].dy })) };
    }

    // goalDiSeq (reversed) = moves from the backtrack ancestor to the goal.
    const goalMoves = [...goalDiSeq].reverse()
      .map(di => ({ dx: _DIRS4G[di].dx, dy: _DIRS4G[di].dy }));

    // btEntry.fromKey    = stateKey(ancPos, ancDi, oldWS) — the backtrack anchor in old worldstate
    // btEntry.triggerKey = stateKey(pos, *, oldWS)        — position the key slide was triggered from
    // btEntry.keySlideDir = direction index of the key-collecting slide
    const ancOldKey      = btEntry.fromKey;
    const ancOldEntry    = parentOf.get(ancOldKey);
    const backtrackChain = ancOldEntry ? (ancOldEntry.chain ?? 0) : 0;

    // Walk the full path from start to key in one backward pass starting at triggerKey.
    // We no longer split at ancPos — that split was fragile: if ancPos was reached via
    // a free-backtrack (isBacktrack=true parent), startDiSeq would be empty.
    // Instead we walk all the way to the root, skipping isBacktrack hop-entries
    // (they are BFS phantom seeds, not real player moves) but continuing through them.
    const allKeyDiSeq = [];
    if (btEntry.keySlideDir !== null && btEntry.keySlideDir !== undefined) {
      allKeyDiSeq.push(btEntry.keySlideDir); // last forward move: the key-collecting slide
    }
    let tc = btEntry.triggerKey;
    let guard = 0;
    while (tc !== undefined && guard++ < 50000) {
      const te = parentOf.get(tc);
      if (!te || te.fromKey === null) break; // reached BFS root
      if (!te.isBacktrack) {
        // Real move entry — push the direction.
        const moveDi = te.moveDir ?? tc % 5;
        if (moveDi < 4) allKeyDiSeq.push(moveDi);
      } else if (te.triggerType === 'crumble') {
        // Crumble phantom in the key path.
        // Only handle zero-move, first-level phantoms (fromKey === triggerKey).
        // Deep ancestor phantoms and non-zero bounces can't be reliably reconstructed.
        if (!te.isZeroMove || te.fromKey !== te.triggerKey) return null;
        // Inject the crumble-slide direction (the zero-move bounce at ancPos).
        // Then tc = te.fromKey below continues the walk from ancPos in wsOld.
        if (te.keySlideDir !== null && te.keySlideDir !== undefined && te.keySlideDir < 4) {
          allKeyDiSeq.push(te.keySlideDir);
        }
      }
      // Key isBacktrack and crumble zero-move first-level: follow fromKey
      // to continue walking the pre-backtrack path in wsOld.
      tc = te.fromKey;
    }
    allKeyDiSeq.reverse(); // now forward: start → ... → triggerPos → key

    const keyMoves = allKeyDiSeq.map(di => ({ dx: _DIRS4G[di].dx, dy: _DIRS4G[di].dy }));

    return { keyMoves, backtrackChain, goalMoves };
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
      const { path, cost, crumblePos, keyPos } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements, teleporterMap);
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

        // Post-oneway exit node: extra exploration from cell after last traversed one-way.
        if (path.length > 1) {
          let lastOWIdx = -1;
          for (let j = 0; j < path.length - 1; j++) {
            if (path[j].cell >= 3 && path[j].cell <= 6) lastOWIdx = j;
          }
          if (lastOWIdx >= 0 && lastOWIdx + 1 < path.length - 1) {
            const exitCell = path[lastOWIdx + 1];
            const exitPk   = posKey(exitCell);
            if (!difficulties.has(exitPk) || difficulties.get(exitPk) > nd) difficulties.set(exitPk, nd);
            const exitSK = stateKey(exitCell, i, worldState);
            if ((diffLandingVis.get(exitSK) ?? Infinity) > nd) {
              diffLandingVis.set(exitSK, nd);
              heapPush({ pos: exitCell, diff: nd, worldState, di: i });
            }
          }
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
  // Also tracks companion gear count (gearsOnChainPath) on each min-chain path.
  const clLenMap      = new Map();
  const clVisMap      = new Map();
  const gearsOnChainPath = new Map();
  clLenMap.set(posKey(start), 0);
  clVisMap.set(stateKey(start, 4, 0), 0);
  gearsOnChainPath.set(posKey(start), 0);
  const clHeap = [{ pos: start, cl: 0, worldState: 0, di: 4, gears: 0 }];
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
    const { pos, cl, worldState, di, gears } = clPop();
    if ((clVisMap.get(stateKey(pos, di, worldState)) ?? Infinity) < cl) continue;
    for (let i = 0; i < DIRS4.length; i++) {
      const { dx, dy } = DIRS4[i];
      const { path, crumblePos, keyPos, blockedByOneway } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements, teleporterMap);
      if (path.length === 0 && !crumblePos) continue;
      const isReversal    = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;
      const chainRetracts = isReversal && blockedByOneway;
      const isBend        = (i !== di) && !isReversal;
      const newGears      = gears + (isBend ? 1 : 0);
      const nCl = chainRetracts ? cl - path.length : cl + path.length;
      for (let j = 0; j < path.length; j++) {
        const k = posKey(path[j]);
        const clj = chainRetracts ? cl - (j + 1) : cl + j + 1;
        if (!clLenMap.has(k) || clLenMap.get(k) > clj) {
          clLenMap.set(k, clj);
          gearsOnChainPath.set(k, newGears);
        }
        _recUCL(worldState, k, clj);
      }
      if (path.length > 0) {
        const landing = path[path.length - 1];
        const ews = keyPos ? (worldState | (1 << keyPos.toggleIdx)) : worldState;
        const lk = stateKey(landing, i, ews);
        if ((clVisMap.get(lk) ?? Infinity) > nCl) { clVisMap.set(lk, nCl); clPush({ pos: landing, cl: nCl, worldState: ews, di: i, gears: newGears }); }
        if (keyPos) _recUCL(ews, posKey(landing), nCl);

        // Post-oneway exit node: extra exploration from cell after last traversed one-way,
        // using chain length and gear count at that intermediate position.
        if (!chainRetracts && path.length > 1) {
          let lastOWIdx = -1;
          for (let j = 0; j < path.length - 1; j++) {
            if (path[j].cell >= 3 && path[j].cell <= 6) lastOWIdx = j;
          }
          if (lastOWIdx >= 0 && lastOWIdx + 1 < path.length - 1) {
            const exitIdx  = lastOWIdx + 1;
            const exitCell = path[exitIdx];
            const exitCl   = cl + exitIdx + 1;
            const exitPk   = posKey(exitCell);
            const exitSK   = stateKey(exitCell, i, worldState);
            if ((clVisMap.get(exitSK) ?? Infinity) > exitCl) {
              clVisMap.set(exitSK, exitCl);
              if (!clLenMap.has(exitPk) || clLenMap.get(exitPk) > exitCl) {
                clLenMap.set(exitPk, exitCl);
                gearsOnChainPath.set(exitPk, newGears);
              }
              _recUCL(worldState, exitPk, exitCl);
              clPush({ pos: exitCell, cl: exitCl, worldState, di: i, gears: newGears });
            }
          }
        }
      }
      if (crumblePos && crumblePos.toggleIdx !== undefined) {
        const nws = worldState | (1 << crumblePos.toggleIdx);
        const from = path.length > 0 ? path[path.length - 1] : pos;
        const fk = posKey(from);
        if (!clLenMap.has(fk) || clLenMap.get(fk) > nCl) {
          clLenMap.set(fk, nCl);
          gearsOnChainPath.set(fk, newGears);
        }
        _recUCL(nws, fk, nCl);
        const lk = stateKey(from, i, nws);
        if ((clVisMap.get(lk) ?? Infinity) > nCl) { clVisMap.set(lk, nCl); clPush({ pos: from, cl: nCl, worldState: nws, di: i, gears: newGears }); }
      }
    }
  }

  // ── Build flat arrays: -1 = unreachable ──────────────────────────────────
  const depthArray        = new Int16Array(width * height).fill(-1);
  const difficultyArray   = new Float32Array(width * height).fill(-1);
  const chainLengthArray  = new Int16Array(width * height).fill(-1);
  const chainOnGearArray  = new Int16Array(width * height).fill(-1); // companion: chain on min-gear path
  const gearsOnChainArray = new Int16Array(width * height).fill(-1); // companion: gears on min-chain path
  for (const [k, d] of depths)           depthArray[k]        = d;
  for (const [k, d] of difficulties)     difficultyArray[k]   = d;
  for (const [k, v] of clLenMap)         chainLengthArray[k]  = v;
  for (const [k, v] of chainOnGearPath)  chainOnGearArray[k]  = v;
  for (const [k, v] of gearsOnChainPath) gearsOnChainArray[k] = v;

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

  // ── Pass 4: Joint reachability within (playerGears, playerChainLength) ──────
  // Dijkstra on chainUsed; state = (pos, di, ws, gearsUsed).
  // Enforces both constraints simultaneously so the goal is only placed at a cell
  // the player can actually land on with their current stats combined.
  const hasBudgets = playerGears !== Infinity || playerChainLength !== Infinity;
  const jointReachable = new Set(); // flat posKeys the player can land on within both budgets
  let jBestAtPos = null;            // populated by Pass 4 when hasBudgets; posFlat → { g, chain }

  if (hasBudgets) {
    const pg = playerGears;
    const pc = playerChainLength;
    const jKey = (p, di, ws, g) => ((ws * width * height + p.y * width + p.x) * 5 + di) * (pg + 1) + g;

    const jVis    = new Map();
    const jParent = new Map();
    const jHeap   = [];
    jBestAtPos = new Map(); // posFlat → { g, chain } with min chain (then min gears)

    function jUpdateBest(pf, newG, newChain) {
      const cur = jBestAtPos.get(pf);
      if (!cur || newChain < cur.chain || (newChain === cur.chain && newG < cur.g)) {
        jBestAtPos.set(pf, { g: newG, chain: newChain });
      }
    }

    function jPush(e) {
      jHeap.push(e); let i = jHeap.length - 1;
      while (i > 0) { const p = (i-1)>>1; if (jHeap[p].chain <= jHeap[i].chain) break; [jHeap[p],jHeap[i]]=[jHeap[i],jHeap[p]]; i=p; }
    }
    function jPop() {
      const top = jHeap[0], last = jHeap.pop();
      if (jHeap.length > 0) {
        jHeap[0] = last; let i = 0;
        while (true) { let s=i,l=2*i+1,r=2*i+2; if(l<jHeap.length&&jHeap[l].chain<jHeap[s].chain)s=l; if(r<jHeap.length&&jHeap[r].chain<jHeap[s].chain)s=r; if(s===i)break; [jHeap[i],jHeap[s]]=[jHeap[s],jHeap[i]]; i=s; }
      }
      return top;
    }
    // Walk ancestor chain; re-enqueue each ancestor at its original (gearsUsed, chainUsed)
    // but with newWS — models the player collecting a toggle and retracting to any prior waypoint.
    function jFreeBacktrack(fromKey, newWS) {
      let curKey = fromKey;
      while (curKey !== null) {
        const e = jParent.get(curKey);
        if (!e) break;
        const nk = jKey(e.pos, e.di, newWS, e.g);
        if ((jVis.get(nk) ?? Infinity) > e.chain) {
          jVis.set(nk, e.chain);
          jParent.set(nk, { fromKey: curKey, pos: e.pos, di: e.di, ws: newWS, g: e.g, chain: e.chain });
          jPush({ pos: e.pos, di: e.di, ws: newWS, g: e.g, chain: e.chain });
          if (e.pos.y >= 0) { jointReachable.add(posKey(e.pos)); jUpdateBest(posKey(e.pos), e.g, e.chain); }
        }
        curKey = e.fromKey;
      }
    }

    // di=3 = DOWN, matching the direction the player arrives from after the entry slide.
    const initKey = jKey(start, 3, 0, 0);
    jVis.set(initKey, 0);
    jParent.set(initKey, { fromKey: null, pos: start, di: 3, ws: 0, g: 0, chain: 0 });
    jointReachable.add(posKey(start));
    if (start.y >= 0) jUpdateBest(posKey(start), 0, 0);
    jPush({ pos: start, di: 3, ws: 0, g: 0, chain: 0 });

    while (jHeap.length > 0) {
      const { pos, di, ws, g, chain } = jPop();
      const sk = jKey(pos, di, ws, g);
      if ((jVis.get(sk) ?? Infinity) < chain) continue;

      for (let i = 0; i < DIRS4.length; i++) {
        const { dx, dy } = DIRS4[i];
        const { path, crumblePos, keyPos, blockedByOneway } = _slidePath(cells, width, height, pos, dx, dy, toggleMap, ws, doorRequirements, teleporterMap);

        const isReversal = di < 4 && dx === -DIRS4[di].dx && dy === -DIRS4[di].dy;
        const isBend     = (i !== di) && !isReversal;
        const newG       = g + (isBend ? 1 : 0);
        if (path.length === 0 && !crumblePos && !(isReversal && blockedByOneway)) continue;
        if (newG > pg) continue;

        // Chain capping: like the game, stop the player early when the budget runs out.
        // One-way-blocked reversals retract the chain; they need no cap.
        const chainRetracts = isReversal && blockedByOneway;
        const avail      = pc - chain;
        const cappedPath = chainRetracts ? path : (path.length <= avail ? path : path.slice(0, avail));

        if (cappedPath.length > 0) {
          const landing    = cappedPath[cappedPath.length - 1];
          const newChain   = chainRetracts ? chain - cappedPath.length : chain + cappedPath.length;
          const keyApplies = keyPos !== null && cappedPath.length === path.length;
          const ews        = keyApplies ? (ws | (1 << keyPos.toggleIdx)) : ws;
          const nk         = jKey(landing, i, ews, newG);
          if ((jVis.get(nk) ?? Infinity) > newChain) {
            jVis.set(nk, newChain);
            jParent.set(nk, { fromKey: sk, pos: landing, di: i, ws: ews, g: newG, chain: newChain });
            jPush({ pos: landing, di: i, ws: ews, g: newG, chain: newChain });
          }
          if (landing.y >= 0) { jointReachable.add(posKey(landing)); jUpdateBest(posKey(landing), newG, newChain); }
          if (keyApplies && keyPos.toggleIdx !== undefined) jFreeBacktrack(sk, ews);
        }

        // Crumble bounce: only process if path wasn't capped before reaching the crumble stop.
        if (crumblePos && crumblePos.toggleIdx !== undefined && cappedPath.length === path.length) {
          const newWS       = ws | (1 << crumblePos.toggleIdx);
          const from        = cappedPath.length > 0 ? cappedPath[cappedPath.length - 1] : pos;
          const crumbleG    = cappedPath.length === 0 ? g : newG;
          const crumbleDi   = cappedPath.length === 0 ? di : i;
          const crumbleChain = chainRetracts ? chain - cappedPath.length : chain + cappedPath.length;
          const nk = jKey(from, crumbleDi, newWS, crumbleG);
          if ((jVis.get(nk) ?? Infinity) > crumbleChain) {
            jVis.set(nk, crumbleChain);
            jParent.set(nk, { fromKey: sk, pos: from, di: crumbleDi, ws: newWS, g: crumbleG, chain: crumbleChain });
            jPush({ pos: from, di: crumbleDi, ws: newWS, g: crumbleG, chain: crumbleChain });
          }
          if (from.y >= 0) { jointReachable.add(posKey(from)); jUpdateBest(posKey(from), crumbleG, crumbleChain); }
          jFreeBacktrack(sk, newWS);
        }

        // One-way backtrack: reversal blocked by one-way retracts the chain back to the
        // parent landing with a shorter chain value — never costs gears.
        if (isReversal && blockedByOneway && path.length === 0) {
          const myEntry = jParent.get(sk);
          if (myEntry?.fromKey != null) {
            const parentEntry = jParent.get(myEntry.fromKey);
            if (parentEntry && (parentEntry.pos.x !== pos.x || parentEntry.pos.y !== pos.y)) {
              const backPos   = parentEntry.pos;
              const backChain = parentEntry.chain;
              const backG     = parentEntry.g;
              const nk = jKey(backPos, di, ws, backG);
              if ((jVis.get(nk) ?? Infinity) > backChain) {
                jVis.set(nk, backChain);
                jParent.set(nk, { fromKey: sk, pos: backPos, di, ws, g: backG, chain: backChain });
                jPush({ pos: backPos, di, ws, g: backG, chain: backChain });
                if (backPos.y >= 0) { jointReachable.add(posKey(backPos)); jUpdateBest(posKey(backPos), backG, backChain); }
              }
            }
          }
        }
      }
    }
  }

  // ── Pick goal: non-wall cell with highest difficulty ──────────────────────
  // Exclude walls, crumbles (goal hidden under crumble = unreachable), keys, doors,
  // and one-ways (player slides through them — can never land on a one-way tile).
  // When player budgets are active, only consider jointly reachable cells.
  let bestPos        = start;
  let bestDifficulty = 0;
  let bestManhattan  = 0;
  for (const [k, d] of difficulties) {
    if (k < 0 || k >= width * height) continue;
    if (cells[k] === 1 || cells[k] === 7 || cells[k] === 8 || cells[k] === 9 || cells[k] === 10) continue;
    if (cells[k] >= 3 && cells[k] <= 6) continue;
    if (carvedMask && !carvedMask[k]) continue;
    if (hasBudgets ? !jointReachable.has(k) : !bestKeyForPos.has(k)) continue;
    const x  = k % width;
    const y  = Math.floor(k / width);
    const nm = Math.abs(x - start.x) + Math.abs(y - start.y);
    if (d > bestDifficulty || (d === bestDifficulty && nm > bestManhattan)) {
      bestDifficulty = d;
      bestManhattan  = nm;
      bestPos        = { x, y };
    }
  }

  // Reconstruct the solution path for the chosen goal now that bestPos is known.
  const solution = _reconstructSolution(bestPos.y * width + bestPos.x);

  return { goal: bestPos, depths: depthArray, difficulties: difficultyArray, chainLengths: chainLengthArray,
           chainOnGearLengths: chainOnGearArray, gearsOnChainDepths: gearsOnChainArray,
           p4BestAtPos: jBestAtPos,
           toggleCount, universeDepths, universeChainLengths, solution };
}

