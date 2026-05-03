import { makeRng } from './random.js';

// ── Internal generator cell values ──────────────────────────────────────────
const G = { UNTOUCHED: 0, EMPTY: 1, STICKY: 2, BLOCK: 3, ONEWAY: 4 };

const DIRS = [
  { key: 'LEFT',  dx: -1, dy:  0 },
  { key: 'UP',    dx:  0, dy: -1 },
  { key: 'RIGHT', dx:  1, dy:  0 },
  { key: 'DOWN',  dx:  0, dy:  1 },
];

// Probability weights for choosing a cell type when carving into UNTOUCHED
const WEIGHTS = { sticky: 0.06, block: 0.10, oneway: 0.02, empty: 1.00 };
const WEIGHT_TOTAL = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// Maps a ONEWAY direction key → the CellType value used in the output level
const ONEWAY_OUT = { LEFT: 3, RIGHT: 4, UP: 5, DOWN: 6 };

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a level using a randomised DFS carving algorithm.
 *
 * @param {number} width   - inner column count (no padding)
 * @param {number} height  - inner row count
 * @param {{ seed?: number, id?: number|string }} [opts]
 * @returns {{ id, width, height, cells: Uint8Array, start: {x,y}, goal: {x,y}, depths: Int16Array }}
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
        default:        out = 1; break;   // CellType.WALL  (BLOCK + UNTOUCHED)
      }
      outCells[y * width + x] = out;
    }
  }

  const start = { x: startX - 1, y: startY - 1 };
  const { goal, depths } = _findGoal(outCells, width, height, start);

  _logLevel(outCells, width, height, start, goal, id);

  return { id, width, height, cells: outCells, start, goal, depths };
}

/**
 * Generate `candidates` levels (consecutive seeds) and return the hardest one
 * (highest max depth value — most moves required to reach the goal).
 *
 * @param {number} width
 * @param {number} height
 * @param {{ seed?: number, id?: number|string, candidates?: number }} [opts]
 */
export function generateHardestLevel(width, height, { seed = 0, id = 1, candidates = 300 } = {}) {
  let best         = null;
  let bestMaxDepth = -1;
  let bestSeed     = seed;

  for (let i = 0; i < candidates; i++) {
    const level    = generateLevel(width, height, { seed: seed + i, id });
    const maxDepth = Math.max(...level.depths);
    if (maxDepth > bestMaxDepth) {
      bestMaxDepth = maxDepth;
      bestSeed     = seed + i;
      best         = level;
    }
  }

  console.log(`[hardest] seed=${bestSeed}  maxDepth=${bestMaxDepth}  (${candidates} candidates)`);
  return best;
}

// ── Debug logging ─────────────────────────────────────────────────────────────

function _logLevel(cells, width, height, start, goal, id) {
  const GLYPHS = ['.', '#', 'S', '←', '→', '↑', '↓'];

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

  const legend = '  . empty  # wall  S sticky  ←→↑↓ oneway  @ start  G goal';
  console.group(`[Level ${id}] ${width}×${height}`);
  console.log(lines.join('\n'));
  console.log(legend);
  console.log(`start=(${start.x},${start.y})  goal=(${goal.x},${goal.y})`);
  console.groupEnd();
}

// ── BFS goal finder ──────────────────────────────────────────────────────────

// Returns every cell traversed (in order), including the landing cell.
function _slidePath(cells, width, height, pos, dx, dy) {
  const path = [];
  let x = pos.x, y = pos.y;
  while (true) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
    const cell = cells[ny * width + nx];
    if (cell === 1) break;                                   // WALL
    if (cell >= 3 && !_onewayAllows(cell, dx, dy)) break;   // ONEWAY wrong dir
    x = nx; y = ny;
    path.push({ x, y });
    if (cell === 2) break;                                   // STICKY
  }
  return path;
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

function _findGoal(cells, width, height, start) {
  // landingVisited: tracks landing positions already queued for BFS expansion
  const landingVisited = new Map();
  // depths: minimum move-count to reach ANY cell (landing or pass-through)
  const depths         = new Map();
  const DIRS4 = [{ dx:-1,dy:0 }, { dx:1,dy:0 }, { dx:0,dy:-1 }, { dx:0,dy:1 }];
  const key = (p) => p.y * width + p.x;

  landingVisited.set(key(start), 0);
  depths.set(key(start), 0);
  const queue = [{ pos: start, depth: 0 }];

  while (queue.length > 0) {
    const { pos, depth } = queue.shift();
    for (const { dx, dy } of DIRS4) {
      const path = _slidePath(cells, width, height, pos, dx, dy);
      if (path.length === 0) continue;

      const nd = depth + 1;

      // Update depth for every cell traversed along this slide (keep minimum)
      for (const p of path) {
        const k = key(p);
        if (!depths.has(k) || depths.get(k) > nd) depths.set(k, nd);
      }

      // Only expand BFS from the landing cell (last in path)
      const landing = path[path.length - 1];
      const lk = key(landing);
      if (landingVisited.has(lk)) continue;
      landingVisited.set(lk, nd);
      queue.push({ pos: landing, depth: nd });
    }
  }

  // Build flat depth array: -1 = unreachable, ≥0 = min move count from start
  const depthArray = new Int16Array(width * height).fill(-1);
  for (const [k, d] of depths) depthArray[k] = d;

  // Pick goal: non-wall cell with the highest depth in the depths map.
  // Since goal triggers on pass-through, depth IS the true difficulty.
  let bestPos       = start;
  let bestDepth     = 0;
  let bestManhattan = 0;
  for (const [k, d] of depths) {
    if (cells[k] === 1) continue;  // skip walls
    const x  = k % width;
    const y  = Math.floor(k / width);
    const nm = Math.abs(x - start.x) + Math.abs(y - start.y);
    if (d > bestDepth || (d === bestDepth && nm > bestManhattan)) {
      bestDepth     = d;
      bestManhattan = nm;
      bestPos       = { x, y };
    }
  }

  return { goal: bestPos, depths: depthArray };
}

