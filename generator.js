import { makeRng } from './random.js';

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

// Incremental difficulty contributions per interaction type (accumulated during carving).
const DIFF = {
  STICKY:           0.5,
  ONEWAY_TRAVERSE:  1.0,
  ONEWAY_BLOCKED:   2.5,
  CRUMBLE:          1.5,
  CRUMBLE_TRAVERSE: 3.0,
  KEY:              2.5,
  DOOR_TRAVERSE:    1.0,
  DOOR_LOCKED:      3.5,
  TELEPORT:         2.0,
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
export function generateLevel(width, height, { seed = 0, id = 1, weights = WEIGHTS, useKeyDoor = true, useTeleporter = false, _steps = null, entrySlide = null, playerGears = Infinity, maxUniverseBits = Infinity } = {}) {
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
  const sealedPaddedIdxs  = new Set();  // cells converted UNTOUCHED→EMPTY by sealTeleporterNeighbors
  let   hasTeleporter    = false;
  const buckets          = [[]];  // buckets[g] = explore entries at gear cost g
  let   currentGearCount = 0;
  let   currentProcessingFrom = null; // { x, y, dir } of the active bucket item (for debug steps)
  let   currentBranchDiff = 0;        // accumulated difficulty of the current carve path (set before rec())
  const gearDepthArr = new Int16Array(width * height).fill(-1);    // min g when each cell was first carved
  const diffDepthArr = new Float32Array(width * height).fill(-1);  // accumulated difficulty at min-gear path
  // Active-universe state — updated whenever a branch is dequeued.
  let currentBranchActivated = [];
  let currentActivatedSet    = new Set();
  // Maps padded door idx → padded key idx, populated as keys are placed.
  const doorToKeyPaddedMap   = new Map();
  // Number of toggle cells (crumbles + keys) placed so far.
  let togglesPlaced = 0;

  // Direction-index helpers — operate on the CURRENT universe's VD.
  function hasVisited(i, dirIdx) {
    return ((currentVD.get(i) ?? 0) & (1 << dirIdx)) !== 0;
  }
  function markVisited(i, dirIdx) {
    currentVD.set(i, (currentVD.get(i) ?? 0) | (1 << dirIdx));
  }
  // For each of the 4 directions from (x, y), compute the gear cost and push
  // an explore entry into the appropriate bucket:
  //   0 gears — straight continuation or reversal
  //   1 gear  — any 90° bend
  // Before enqueuing, 90° adjacent UNTOUCHED cells are pre-carved to a definite type.
  // If left UNTOUCHED, they could be carved as crumbles after the bend entry is enqueued,
  // causing that crumble's universe to open at the wrong (higher) gear cost.
  // Straight/reversal directions are never UNTOUCHED: straight is either what stopped us
  // (already carved) or a sticky we landed on (sticky handled by carve); reversal is
  // where we came from (already carved).
  // After the direction loop, each adjacent unactivated crumble is hit for free,
  // opening its universe at the same gear cost. Multi-crumble chains use recursion.
  function enqueueExplores(x, y, arrivalDir, activated, accDiff = 0) {
    const activatedSet = new Set(activated);
    const aDir = DIRS[arrivalDir];

    // Pre-carve 90° adjacent untouched cells to a definite type.
    for (let E = 0; E < 4; E++) {
      const eDir = DIRS[E];
      if (E === arrivalDir || (eDir.dx === -aDir.dx && eDir.dy === -aDir.dy)) continue;
      const nx = x + eDir.dx, ny = y + eDir.dy;
      if (nx < 1 || nx >= pw - 1 || ny < 1 || ny >= ph - 1) continue;
      const ni = idx(nx, ny);
      if (cells[ni] !== G.UNTOUCHED) continue;
      const type = pickType();
      if (type === 'crumble' && togglesPlaced < maxUniverseBits) {
        togglesPlaced++;
        cells[ni] = G.CRUMBLE;
      } else if (type === 'sticky') {
        cells[ni] = G.STICKY;
      } else if (type === 'oneway' && hasOnewayRoom(nx, ny, eDir)) {
        if (cells[idx(nx + eDir.dx, ny + eDir.dy)] === G.UNTOUCHED)
          cells[idx(nx + eDir.dx, ny + eDir.dy)] = G.EMPTY;
        cells[ni] = G.ONEWAY;
        onewayDir.set(ni, E);
      } else if (type === 'block' || type === 'crumble') {
        cells[ni] = G.BLOCK;
      } else {
        cells[ni] = G.EMPTY;
      }
    }

    for (let E = 0; E < 4; E++) {
      const eDir       = DIRS[E];
      const ni         = idx(x + eDir.dx, y + eDir.dy);
      // Unactivated adjacent crumbles are handled exclusively by the hit loop below.
      if (cells[ni] === G.CRUMBLE && !activatedSet.has(ni)) continue;
      const isStraight = E === arrivalDir;
      const isReversal = eDir.dx === -aDir.dx && eDir.dy === -aDir.dy;
      const isFree     = isStraight || isReversal;
      const g = currentGearCount + (isFree ? 0 : 1);
      while (buckets.length <= g) buckets.push([]);
      buckets[g].push({ x, y, arrivalDir, exploreDir: E, activated, accDiff });
    }
    for (let E = 0; E < 4; E++) {
      const eDir = DIRS[E];
      const ni   = idx(x + eDir.dx, y + eDir.dy);
      if (cells[ni] === G.CRUMBLE && !activatedSet.has(ni)) {
        enqueueExplores(x, y, arrivalDir, [...activated, ni].sort((a, b) => a - b), accDiff + DIFF.CRUMBLE);
      }
    }
  }

  function enqueue(x, y, arrivalDir, accDiff = 0) {
    enqueueExplores(x, y, arrivalDir, currentBranchActivated, accDiff);
  }

  // Push explores for (queueX, queueY) in the universe where toggleCellIdx is activated.
  // The crumble/key activation itself costs 0 gears (currentGearCount unchanged).
  function enqueueActivated(toggleCellIdx, queueX, queueY, arrivalDir, accDiff = 0) {
    const activated = [...currentBranchActivated, toggleCellIdx].sort((a, b) => a - b);
    enqueueExplores(queueX, queueY, arrivalDir, activated, accDiff);
  }

  // Convert cell ni to EMPTY and continue carving in dirIdx from (nx, ny).
  // Used as the fallback when a randomly-chosen type can't be placed.
  function carveEmpty(dirIdx, x, y, nx, ny, ni, accDiff = 0) {
    cells[ni] = G.EMPTY;
    currentBranchDiff = accDiff;
    rec(x, y, nx, ny, `empty (${nx-1},${ny-1})`);
    carve(dirIdx, nx, ny, dirIdx, accDiff);
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
    // Always record depth — needed for goal selection and overlay regardless of debug mode.
    if (toX >= 1 && toX < pw - 1 && toY >= 1 && toY < ph - 1) {
      const fi = (toY - 1) * width + (toX - 1);
      if (gearDepthArr[fi] < 0 || currentGearCount < gearDepthArr[fi]) {
        gearDepthArr[fi] = currentGearCount;
        diffDepthArr[fi] = currentBranchDiff;
      } else if (currentGearCount === gearDepthArr[fi] && currentBranchDiff < diffDepthArr[fi]) {
        diffDepthArr[fi] = currentBranchDiff;
      }
    }
    if (!_steps) return;
    // Snapshot every universe's VD so the visualiser can show per-universe exploration.
    const allUniverseVDs = new Map();
    for (const [k, vd] of universeVDs) {
      allUniverseVDs.set(k, new Map(vd));
    }
    // Also surface universes that are queued but not yet dequeued — universeVDs
    // only gets an entry on dequeue, so without this new panels wouldn't appear
    // until the branch is actually processed.
    for (const bucket of buckets) {
      for (const item of bucket) {
        const uKey = (item.activated ?? []).join(',');
        if (!allUniverseVDs.has(uKey)) {
          allUniverseVDs.set(uKey, new Map());
        }
      }
    }
    // Snapshot the frontier grouped by universe key.
    const frontier     = new Map();
    const doorFrontier = new Map();
    for (const bucket of buckets) {
      for (const item of bucket) {
        const uKey = (item.activated ?? []).join(',');
        if (!frontier.has(uKey)) frontier.set(uKey, new Set());
        frontier.get(uKey).add(item.y * pw + item.x);
      }
    }
    _steps.push({ grid: new Uint8Array(cells), onewayDir: new Map(onewayDir), allUniverseVDs, frontier, doorFrontier, currentUniverseKey, pw, ph, fromX, fromY, toX, toY, label, gearCount: currentGearCount, processingFrom: currentProcessingFrom, activated: currentBranchActivated.slice(), teleporterPairs: paddedTeleporterMap.size > 0 ? new Map(paddedTeleporterMap) : null, gearDepths: gearDepthArr.slice() });
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
      const ni = idx(nx, ny);
      if (cells[ni] === G.UNTOUCHED) { cells[ni] = G.EMPTY; sealedPaddedIdxs.add(ni); }
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

  function carveUntouched(dirIdx, x, y, nx, ny, ni, dir, arrivalDirIdx = dirIdx, accDiff = 0) {
    const type = pickType();
    if (type === 'empty') {
      carveEmpty(dirIdx, x, y, nx, ny, ni, accDiff);
    } else if (type === 'oneway') {
      if (hasOnewayRoom(nx, ny, dir)) {
        cells[idx(nx + dir.dx, ny + dir.dy)] = G.EMPTY;
        cells[ni] = G.ONEWAY;
        onewayDir.set(ni, dirIdx);
      } else {
        cells[ni] = G.EMPTY;
      }
      currentBranchDiff = accDiff + DIFF.ONEWAY_TRAVERSE;
      rec(x, y, nx, ny, `oneway-${dir.key} (${nx-1},${ny-1})`);
      carve(dirIdx, nx, ny, dirIdx, accDiff + DIFF.ONEWAY_TRAVERSE);
    } else if (type === 'block') {
      cells[ni] = G.BLOCK;
      currentBranchDiff = accDiff;
      rec(x, y, nx, ny, `block (${nx-1},${ny-1})`);
      enqueue(x, y, arrivalDirIdx, accDiff);
    } else if (type === 'crumble') {
      if (togglesPlaced >= maxUniverseBits) { carveEmpty(dirIdx, x, y, nx, ny, ni, accDiff); return; }
      togglesPlaced++;
      cells[ni] = G.CRUMBLE;
      currentBranchDiff = accDiff + DIFF.CRUMBLE;
      rec(x, y, nx, ny, `crumble (${nx-1},${ny-1})`);
      // Queue (x,y) only in the crumble-activated universe with a fresh VD.
      // Bumping a crumble immediately activates it, so there is no game state
      // where the player is at (x,y) with the crumble still intact.
      enqueueActivated(ni, x, y, arrivalDirIdx, accDiff + DIFF.CRUMBLE);
    } else if (type === 'key' && useKeyDoor && keyDoorPairs.length === 0) {
      const door = findDoorCandidate(ni);
      if (door && togglesPlaced < maxUniverseBits) {
        togglesPlaced++;
        cells[ni] = G.KEY;
        cells[door.ci] = G.DOOR;
        keyDoorPairs.push({ keyI: ni, doorI: door.ci });
        doorToKeyPaddedMap.set(door.ci, ni);
        currentBranchDiff = accDiff + DIFF.KEY;
        rec(x, y, nx, ny, `key (${nx-1},${ny-1})`);
        // Queue the key cell in the key-activated universe with a fresh VD.
        // The player lands on the key and immediately collects it, so exploration
        // starts clean — no inherited visited-dirs from before the key was collected.
        // The carver will reach the door naturally from the key side and slide through
        // (door is open), so no extra far-side seeding is needed.
        enqueueActivated(ni, nx, ny, dirIdx, accDiff + DIFF.KEY);
      } else {
        carveEmpty(dirIdx, x, y, nx, ny, ni, accDiff);
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
          currentBranchDiff = accDiff + DIFF.TELEPORT;
          rec(x, y, nx, ny, `teleporter (${nx-1},${ny-1}) ↔ (${ex-1},${ey-1})`);
          // Player slides through the entry and emerges at the exit.
          // Mark the entry as visited so it's not re-entered from this direction,
          // then continue carving from the exit in the same direction.
          markVisited(ni, dirIdx);
          if (!hasVisited(exitNi, dirIdx)) carve(dirIdx, ex, ey, dirIdx, accDiff + DIFF.TELEPORT);
        } else {
          carveEmpty(dirIdx, x, y, nx, ny, ni, accDiff);
        }
      } else {
        carveEmpty(dirIdx, x, y, nx, ny, ni, accDiff);
      }
    } else {
      cells[ni] = G.STICKY;
      currentBranchDiff = accDiff + DIFF.STICKY;
      rec(x, y, nx, ny, `sticky (${nx-1},${ny-1})`);
      enqueue(nx, ny, dirIdx, accDiff + DIFF.STICKY);
    }
  }

  // Carving — slide physics respected: same-direction recursion continues through
  // empty/oneway cells (one slide = one logical step).
  function carve(dirIdx, x, y, arrivalDirIdx = dirIdx, accDiff = 0) {
    const i = idx(x, y);
    if (hasVisited(i, dirIdx)) return;
    markVisited(i, dirIdx);

    const dir  = DIRS[dirIdx];
    const nx   = x + dir.dx;
    const ny   = y + dir.dy;
    const ni   = idx(nx, ny);
    const cell = cells[ni];

    switch (cell) {
      case G.UNTOUCHED: carveUntouched(dirIdx, x, y, nx, ny, ni, dir, arrivalDirIdx, accDiff); break;
      case G.EMPTY:
        currentBranchDiff = accDiff;
        rec(x, y, nx, ny, `slide-empty (${nx-1},${ny-1})`);
        if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny, dirIdx, accDiff);
        break;
      case G.CRUMBLE:
        if (currentActivatedSet.has(ni)) {
          currentBranchDiff = accDiff + DIFF.CRUMBLE_TRAVERSE;
          rec(x, y, nx, ny, `slide-crumble-gone (${nx-1},${ny-1})`);
          if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny, dirIdx, accDiff + DIFF.CRUMBLE_TRAVERSE);
        } else {
          currentBranchDiff = accDiff + DIFF.CRUMBLE;
          rec(x, y, nx, ny, `stopped-crumble (${nx-1},${ny-1})`);
          enqueueActivated(ni, x, y, arrivalDirIdx, accDiff + DIFF.CRUMBLE);
        }
        break;
      case G.BLOCK:
        currentBranchDiff = accDiff;
        rec(x, y, nx, ny, `stopped-block (${nx-1},${ny-1})`);
        enqueue(x, y, arrivalDirIdx, accDiff);
        break;
      case G.STICKY:
        currentBranchDiff = accDiff + DIFF.STICKY;
        rec(x, y, nx, ny, `stopped-sticky (${nx-1},${ny-1})`);
        enqueue(nx, ny, dirIdx, accDiff + DIFF.STICKY);
        break;
      case G.ONEWAY: {
        const allowedDir = onewayDir.get(ni);
        if (allowedDir === dirIdx) {
          currentBranchDiff = accDiff + DIFF.ONEWAY_TRAVERSE;
          rec(x, y, nx, ny, `slide-oneway-allowed (${nx-1},${ny-1})`);
          carve(dirIdx, nx, ny, dirIdx, accDiff + DIFF.ONEWAY_TRAVERSE);
        } else {
          currentBranchDiff = accDiff + DIFF.ONEWAY_BLOCKED;
          rec(x, y, nx, ny, `stopped-oneway-blocked (${nx-1},${ny-1})`);
          enqueue(x, y, arrivalDirIdx, accDiff + DIFF.ONEWAY_BLOCKED);
        }
        break;
      }
      case G.KEY:
        if (currentActivatedSet.has(ni)) {
          currentBranchDiff = accDiff;
          rec(x, y, nx, ny, `slide-key-collected (${nx-1},${ny-1})`);
          if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny, dirIdx, accDiff);
        } else {
          currentBranchDiff = accDiff + DIFF.KEY;
          rec(x, y, nx, ny, `stopped-key (${nx-1},${ny-1})`);
          enqueueActivated(ni, nx, ny, dirIdx, accDiff + DIFF.KEY);
        }
        break;
      case G.DOOR: {
        const keyPad = doorToKeyPaddedMap.get(ni);
        if (keyPad !== undefined && currentActivatedSet.has(keyPad)) {
          currentBranchDiff = accDiff + DIFF.DOOR_TRAVERSE;
          rec(x, y, nx, ny, `slide-door-open (${nx-1},${ny-1})`);
          if (!hasVisited(ni, dirIdx)) carve(dirIdx, nx, ny, dirIdx, accDiff + DIFF.DOOR_TRAVERSE);
        } else {
          currentBranchDiff = accDiff + DIFF.DOOR_LOCKED;
          rec(x, y, nx, ny, `stopped-door-locked (${nx-1},${ny-1})`);
          enqueue(x, y, arrivalDirIdx, accDiff + DIFF.DOOR_LOCKED);
        }
        break;
      }
      case G.TELEPORTER: {
        const exitNi = paddedTeleporterMap.get(ni);
        if (exitNi !== undefined && !hasVisited(exitNi, dirIdx)) {
          const ex = exitNi % pw, ey = Math.floor(exitNi / pw);
          currentBranchDiff = accDiff + DIFF.TELEPORT;
          rec(x, y, nx, ny, `slide-teleporter (${nx-1},${ny-1}) → (${ex-1},${ey-1})`);
          carve(dirIdx, ex, ey, dirIdx, accDiff + DIFF.TELEPORT);
        }
        break;
      }
    }
  }

  // ── Main generation loop ──
  // The entry cell (startY, unpadded y=0) is always traversed for free on entry
  // but is never the start of a carve() call, so rec() only records it if the BFS
  // later slides UP through it.  A one-way in the entry column can block that, leaving
  // diffDepthArr=-1 and causing goal selection's default fallback to place the goal there.
  // Seed it explicitly at g=0/diff=0 so it's always a valid (but lowest-priority) candidate.
  gearDepthArr[(startY - 1) * width + (startX - 1)] = 0;
  diffDepthArr[(startY - 1) * width + (startX - 1)] = 0;
  gearDepthArr[startY * width + (startX - 1)] = 0;
  diffDepthArr[startY * width + (startX - 1)] = 0;
  // Begin carving from the second tunnel cell (startY+1), one row below the
  // boat entry.  This ensures the entry cell (startY) is never enqueued as a
  // BFS source and so is never explored laterally — matching the player physics
  // where the first slide always passes through the entry cell.
  carve(3 /* DOWN */, startX, startY + 1);
  // Process explore entries in gear-cost order: bucket[0] (free moves) before
  // bucket[1] (1-gear bends), etc.  Entries added to the current bucket during
  // processing are picked up immediately (bucket.length checked dynamically).
  for (let g = 0; g < buckets.length; g++) {
    const bucket = buckets[g];
    for (let head = 0; head < bucket.length; head++) {
      const { x, y, arrivalDir, exploreDir, activated, accDiff } = bucket[head];
      currentGearCount       = g;
      currentBranchDiff      = accDiff ?? 0;
      currentProcessingFrom  = { x: x - 1, y: y - 1, dir: DIRS[exploreDir].key };
      currentBranchActivated = activated ?? [];
      currentActivatedSet    = new Set(currentBranchActivated);
      currentUniverseKey     = currentBranchActivated.join(',');
      if (!universeVDs.has(currentUniverseKey)) {
        universeVDs.set(currentUniverseKey, new Map());
      }
      currentVD = universeVDs.get(currentUniverseKey);
      const pending = buckets.reduce((n, b) => n + b.length, 0) - head - 1;
      rec(x, y, -1, -1, `▶ processing (${x-1},${y-1}) dir=${DIRS[exploreDir].key} g=${g}  pending: ${pending}`);
      carve(exploreDir, x, y, arrivalDir, accDiff ?? 0);
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
  // Sealed teleporter-neighbor cells are excluded: they were never carved by the BFS
  // and the player may only slide through them without being able to stop there.
  const carvedMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi = idx(x + 1, y + 1);
      if (cells[pi] !== G.UNTOUCHED && !sealedPaddedIdxs.has(pi)) carvedMask[y * width + x] = 1;
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

  // Select goal: carved EMPTY/STICKY/TELEPORTER cell with the highest accumulated difficulty,
  // tie-broken by Manhattan distance from start.
  let goal = { x: start.x, y: Math.max(start.y, 0) };
  let _bestDiff = -1, _bestManhattan = 0;
  for (let flat = 0; flat < width * height; flat++) {
    if (diffDepthArr[flat] < 0) continue;
    if (carvedMask && !carvedMask[flat]) continue;
    const cell = outCells[flat];
    if (cell === 1 || (cell >= 3 && cell <= 9)) continue; // exclude walls, oneways, crumble, key, door
    const gx = flat % width, gy = Math.floor(flat / width);
    const nm = Math.abs(gx - start.x) + Math.abs(gy - start.y);
    if (diffDepthArr[flat] > _bestDiff || (diffDepthArr[flat] === _bestDiff && nm > _bestManhattan)) {
      _bestDiff = diffDepthArr[flat]; _bestManhattan = nm; goal = { x: gx, y: gy };
    }
  }
  const goalFlat       = goal.y * width + goal.x;
  const effectiveCogs  = Math.max(1, gearDepthArr[goalFlat] >= 0 ? gearDepthArr[goalFlat] : 1);
  const goalDifficulty = diffDepthArr[goalFlat] >= 0 ? diffDepthArr[goalFlat] : 0;
  const depths         = gearDepthArr;
  const universeDepths = null;
  const pathWorldStates = new Set();

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
    effectiveCogs, goalDifficulty,
    depths, difficulties: diffDepthArr, universeDepths,
    doorRequirements, teleporterMap, seed,
    visitedDirs: visitedDirsOut, useKeyDoor,
    pathWorldStates,
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
export function generateHardestLevel(width, height, { seed = 0, id = 1, candidates = 300, weights = WEIGHTS, useKeyDoor = true, useTeleporter = false, difficultyTarget = null, entrySlide = null, playerGears = Infinity, maxUniverseBits = Infinity } = {}) {
  let best      = null;
  let bestScore = Infinity;

  for (let i = 0; i < candidates; i++) {
    const level = generateLevel(width, height, { seed: seed + i, id, weights, useKeyDoor, useTeleporter, entrySlide, playerGears, maxUniverseBits });
    const d = level.goalDifficulty;
    const score = difficultyTarget !== null ? Math.abs(d - difficultyTarget) : -d;

    if (score < bestScore) {
      bestScore = score;
      best      = level;
      if (difficultyTarget !== null && bestScore < 0.5) break;
    }
  }

  best.weights         = weights;
  best.useKeyDoor      = useKeyDoor;
  best.useTeleporter   = useTeleporter;
  best.maxUniverseBits = maxUniverseBits;
  return best;
}


