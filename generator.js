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

// The four orthogonal directions — shared across _slidePath, _simpleGoal, etc.
const DIRS4 = [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 }];


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

  // Push a branch for (queueX, queueY) in the universe where toggleCellIdx is activated.
  // Deduplicates by (universe, position) so the same branch is never enqueued twice.
  function enqueueActivated(toggleCellIdx, queueX, queueY) {
    const activated = [...currentBranchActivated, toggleCellIdx].sort((a, b) => a - b);
    const bpk = `${activated.join(',')}|${queueX},${queueY}`;
    if (!branchPosSet.has(bpk)) {
      branchPosSet.add(bpk);
      branchQueue.push({ x: queueX, y: queueY, activated });
    }
  }

  // Convert cell ni to EMPTY and continue carving in dirIdx from (nx, ny).
  // Used as the fallback when a randomly-chosen type can't be placed.
  function carveEmpty(dirIdx, x, y, nx, ny, ni) {
    cells[ni] = G.EMPTY;
    rec(x, y, nx, ny, `empty (${nx-1},${ny-1})`);
    carve(dirIdx, nx, ny);
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
      carveEmpty(dirIdx, x, y, nx, ny, ni);
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
      enqueueActivated(ni, x, y);
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
        enqueueActivated(ni, nx, ny);
      } else {
        carveEmpty(dirIdx, x, y, nx, ny, ni);
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
          carveEmpty(dirIdx, x, y, nx, ny, ni);
        }
      } else {
        carveEmpty(dirIdx, x, y, nx, ny, ni);
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
          enqueueActivated(ni, x, y);
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
          enqueueActivated(ni, nx, ny);
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
  // Toggle indices match buildToggleMap: sequential over all CRUMBLE(7) and KEY(8) cells
  // in flat scan order.
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

  const { goal, effectiveCogs, effectiveChainLength } =
    _simpleGoal(outCells, width, height, start, doorRequirements, teleporterMap, carvedMask);

  // Translate base-universe visitedDirs from padded indices → unpadded flat indices for export
  const visitedDirsOut = new Map();
  for (const [pi, bits] of (universeVDs.get('') ?? [])) {
    const px = pi % pw, py = Math.floor(pi / pw);
    if (px >= 1 && px < pw - 1 && py >= 1 && py < ph - 1) {
      visitedDirsOut.set((py - 1) * width + (px - 1), dirBitsToSet(bits));
    }
  }

  return {
    id, width, height, cells: outCells, start, goal,
    effectiveCogs, effectiveChainLength,
    doorRequirements, teleporterMap, seed,
    visitedDirs: visitedDirsOut, useKeyDoor,
  };
}

/**
 * Generate `candidates` levels (consecutive seeds) and return the hardest one
 * (most slide moves required to reach the goal — highest effectiveCogs).
 * When difficultyTarget is set, pick the level whose effectiveCogs is closest.
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
    const d = level.effectiveCogs;
    const score = difficultyTarget !== null ? Math.abs(d - difficultyTarget) : -d;

    if (score < bestScore) {
      bestScore = score;
      best      = level;
      if (difficultyTarget !== null && bestScore < 0.5) break;
    }
  }

  best.weights       = weights;
  best.useKeyDoor    = useKeyDoor;
  best.useTeleporter = useTeleporter;
  return best;
}


// ── Slide-path helper ────────────────────────────────────────────────────────
//
// toggleMap       : Map<flatIdx, toggleIdx>   — from buildToggleMap()
// worldState      : number                    — bitmask of active toggles
// doorRequirements: Map<flatIdx, toggleIdx>   — which toggle each door cell requires
function _slidePath(cells, width, height, pos, dx, dy, toggleMap, worldState, doorRequirements = null, teleporterMap = null, gearSet = null) {
  const path = [];
  let x = pos.x, y = pos.y;
  let crumblePos   = null;
  let keyPos       = null;
  let teleportSeen = null; // Set of entry flatIdx — prevents infinite loops (T1→T2→T1→…)

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
      if (!open) break;
      // Open — treat as empty (fall through)
    }

    if (cell >= 3 && cell <= 6 && !_onewayAllows(cell, dx, dy)) break; // ONEWAY wrong dir

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

  return { path, crumblePos, keyPos };
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

// ── Simple goal finder ────────────────────────────────────────────────────────

/**
 * BFS over (pos, worldState) using slide physics to find the hardest-to-reach
 * landable cell (most slide moves from start). Returns { goal, effectiveCogs,
 * effectiveChainLength } where effectiveCogs = slide count and
 * effectiveChainLength = width + height (generous budget).
 */
function _simpleGoal(cells, width, height, start, doorRequirements, teleporterMap, carvedMask) {
  const toggleMap = buildToggleMap(cells);
  const visited   = new Map(); // `${flat},${ws}` → true
  const queue     = [];
  const initFlat  = start.y < 0 ? -1 : start.y * width + start.x;
  visited.set(`${initFlat},0`, true);
  queue.push({ pos: start, hops: 0, ws: 0 });

  let bestPos       = { x: start.x, y: Math.max(start.y, 0) };
  let bestHops      = 0;
  let bestManhattan = 0;

  while (queue.length > 0) {
    const { pos, hops, ws } = queue.shift();

    for (const { dx, dy } of DIRS4) {
      const { path, keyPos, crumblePos } = _slidePath(
        cells, width, height, pos, dx, dy, toggleMap, ws, doorRequirements, teleporterMap
      );

      // Crumble bounce: player stays at pos, worldState advances, no movement
      if (path.length === 0 && crumblePos?.toggleIdx !== undefined) {
        const newWS = ws | (1 << crumblePos.toggleIdx);
        const flat  = pos.y < 0 ? -1 : pos.y * width + pos.x;
        const key   = `${flat},${newWS}`;
        if (!visited.has(key)) { visited.set(key, true); queue.push({ pos, hops, ws: newWS }); }
        continue;
      }
      if (path.length === 0) continue;

      const landing = path[path.length - 1];
      const newWS   = keyPos?.toggleIdx !== undefined ? (ws | (1 << keyPos.toggleIdx)) : ws;
      const flat    = landing.y * width + landing.x;
      const key     = `${flat},${newWS}`;

      if (!visited.has(key)) {
        visited.set(key, true);
        queue.push({ pos: landing, hops: hops + 1, ws: newWS });

        // Valid goal: EMPTY(0) or STICKY(2), in-grid, explicitly carved
        const cell = cells[flat];
        if ((cell === 0 || cell === 2) && landing.y >= 0 &&
            (!carvedMask || carvedMask[flat])) {
          const nm = Math.abs(landing.x - start.x) + Math.abs(landing.y - start.y);
          if (hops + 1 > bestHops || (hops + 1 === bestHops && nm > bestManhattan)) {
            bestHops      = hops + 1;
            bestManhattan = nm;
            bestPos       = { x: landing.x, y: landing.y };
          }
        }
      }
    }
  }

  return {
    goal:                 { x: bestPos.x, y: bestPos.y },
    effectiveCogs:        Math.max(1, bestHops),
    effectiveChainLength: width + height,
  };
}

