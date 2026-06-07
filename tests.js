import { makeRng } from './random.js';
import {
  CellType, isOneway, onewayAllows,
  buildToggleMap, isToggleActive,
  slidePlayer,
} from './puzzle.js';
import { generateLevel } from './generator.js';

// ── Runner ────────────────────────────────────────────────────────────────────

const results = [];
let _group = '';

function group(name) { _group = name; }

function test(name, fn) {
  try {
    fn();
    results.push({ group: _group, name, pass: true });
  } catch (e) {
    results.push({ group: _group, name, pass: false, msg: e.message });
  }
}

function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

function eq(a, b) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Level builder ─────────────────────────────────────────────────────────────
// Build a level from an array of strings. Character map:
//   .  EMPTY       W  WALL        S  STICKY      C  CRUMBLE
//   <  ONEWAY_LEFT  >  ONEWAY_RIGHT
//   ^  ONEWAY_UP   v  ONEWAY_DOWN
//   @  start pos (cell stays EMPTY)   G  goal pos (cell stays EMPTY)
// opts.start / opts.goal override the @ / G markers.
function makeLevel(rows, { start, goal } = {}) {
  const height = rows.length;
  const width  = rows[0].length;
  const cells  = new Uint8Array(width * height);
  let s = start ?? null;
  let g = goal   ?? null;
  const charMap = {
    '.': CellType.EMPTY,        'W': CellType.WALL,
    'S': CellType.STICKY,       'C': CellType.CRUMBLE,
    '<': CellType.ONEWAY_LEFT,  '>': CellType.ONEWAY_RIGHT,
    '^': CellType.ONEWAY_UP,    'v': CellType.ONEWAY_DOWN,
    '@': CellType.EMPTY,        'G': CellType.EMPTY,
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      cells[y * width + x] = charMap[ch] ?? CellType.EMPTY;
      if (ch === 'G' && !g) g = { x, y };
      if (ch === '@' && !s) s = { x, y };
    }
  }
  // Default start: boat above mid-column (off-grid at y=-1, won't interfere with tests)
  if (!s) s = { x: Math.floor(width / 2), y: -1 };
  if (!g) g = { x: 0, y: 0 };
  return { width, height, cells, start: s, goal: g };
}

// ── random.js ─────────────────────────────────────────────────────────────────

group('random');

test('values are in [0, 1)', () => {
  const rng = makeRng(42);
  for (let i = 0; i < 500; i++) {
    const v = rng();
    assert(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

test('same seed produces identical sequence', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 50; i++) eq(a(), b());
});

test('different seeds produce different sequences', () => {
  const a = makeRng(1);
  const b = makeRng(2);
  let differs = false;
  for (let i = 0; i < 20; i++) if (a() !== b()) { differs = true; break; }
  assert(differs, 'seeds 1 and 2 gave identical sequences');
});

test('seed 0 is not degenerate', () => {
  const rng = makeRng(0);
  const vals = Array.from({ length: 10 }, () => rng());
  assert(new Set(vals).size > 1, 'seed 0 produced constant output');
});

// ── puzzle.js — cell type helpers ─────────────────────────────────────────────

group('puzzle / cell types');

test('isOneway: true for all four oneway types', () => {
  assert(isOneway(CellType.ONEWAY_LEFT),  'ONEWAY_LEFT');
  assert(isOneway(CellType.ONEWAY_RIGHT), 'ONEWAY_RIGHT');
  assert(isOneway(CellType.ONEWAY_UP),    'ONEWAY_UP');
  assert(isOneway(CellType.ONEWAY_DOWN),  'ONEWAY_DOWN');
});

test('isOneway: false for non-oneway types', () => {
  assert(!isOneway(CellType.EMPTY),   'EMPTY');
  assert(!isOneway(CellType.WALL),    'WALL');
  assert(!isOneway(CellType.STICKY),  'STICKY');
  assert(!isOneway(CellType.CRUMBLE), 'CRUMBLE');
});

test('onewayAllows: LEFT only accepts dx=-1', () => {
  assert( onewayAllows(CellType.ONEWAY_LEFT, -1,  0), 'LEFT ←');
  assert(!onewayAllows(CellType.ONEWAY_LEFT,  1,  0), 'LEFT →');
  assert(!onewayAllows(CellType.ONEWAY_LEFT,  0,  1), 'LEFT ↓');
  assert(!onewayAllows(CellType.ONEWAY_LEFT,  0, -1), 'LEFT ↑');
});

test('onewayAllows: RIGHT only accepts dx=+1', () => {
  assert( onewayAllows(CellType.ONEWAY_RIGHT,  1,  0), 'RIGHT →');
  assert(!onewayAllows(CellType.ONEWAY_RIGHT, -1,  0), 'RIGHT ←');
  assert(!onewayAllows(CellType.ONEWAY_RIGHT,  0,  1), 'RIGHT ↓');
  assert(!onewayAllows(CellType.ONEWAY_RIGHT,  0, -1), 'RIGHT ↑');
});

test('onewayAllows: UP only accepts dy=-1', () => {
  assert( onewayAllows(CellType.ONEWAY_UP,  0, -1), 'UP ↑');
  assert(!onewayAllows(CellType.ONEWAY_UP,  0,  1), 'UP ↓');
  assert(!onewayAllows(CellType.ONEWAY_UP,  1,  0), 'UP →');
  assert(!onewayAllows(CellType.ONEWAY_UP, -1,  0), 'UP ←');
});

test('onewayAllows: DOWN only accepts dy=+1', () => {
  assert( onewayAllows(CellType.ONEWAY_DOWN,  0,  1), 'DOWN ↓');
  assert(!onewayAllows(CellType.ONEWAY_DOWN,  0, -1), 'DOWN ↑');
  assert(!onewayAllows(CellType.ONEWAY_DOWN,  1,  0), 'DOWN →');
  assert(!onewayAllows(CellType.ONEWAY_DOWN, -1,  0), 'DOWN ←');
});

// ── puzzle.js — toggle map ────────────────────────────────────────────────────

group('puzzle / toggleMap');

test('assigns sequential indices to CRUMBLE and KEY cells', () => {
  // flat: [EMPTY, CRUMBLE, KEY, EMPTY, CRUMBLE]  →  indices 0,1,2 at positions 1,2,4
  const cells = new Uint8Array([0, 7, 8, 0, 7]);
  const map = buildToggleMap(cells);
  eq(map.size, 3);
  eq(map.get(1), 0);
  eq(map.get(2), 1);
  eq(map.get(4), 2);
});

test('EMPTY, WALL, STICKY and oneway cells are not mapped', () => {
  const cells = new Uint8Array([0, 1, 2, 3, 4, 5, 6]); // all non-activating types
  eq(buildToggleMap(cells).size, 0);
});

test('isToggleActive checks the correct bit', () => {
  const cells = new Uint8Array([7, 8]); // CRUMBLE→toggle 0, KEY→toggle 1
  const map = buildToggleMap(cells);
  assert(!isToggleActive(map, 0b00, 0), 'ws=0, crumble not active');
  assert( isToggleActive(map, 0b01, 0), 'ws=1, crumble active');
  assert(!isToggleActive(map, 0b01, 1), 'ws=1, key not active');
  assert( isToggleActive(map, 0b10, 1), 'ws=2, key active');
  assert( isToggleActive(map, 0b11, 0), 'ws=3, crumble active');
  assert( isToggleActive(map, 0b11, 1), 'ws=3, key active');
});

// ── puzzle.js — slidePlayer ───────────────────────────────────────────────────

group('puzzle / slidePlayer');

test('slides until stopped before a wall', () => {
  // . . W . .  — wall at col 2, player at col 0 slides right → lands at col 1
  const level = makeLevel(['..W..']);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0);
  eq(r.x, 1); eq(r.y, 0);
  eq(r.crumble, null);
});

test('slides to grid boundary when nothing stops it', () => {
  const level = makeLevel(['....']);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0);
  eq(r.x, 3); eq(r.y, 0);
});

test('does not move when wall is immediately ahead', () => {
  // . . W .  — player at col 1, wall at col 2 → stays at col 1
  const level = makeLevel(['..W.']);
  const r = slidePlayer(level, { x: 1, y: 0 }, 1, 0);
  eq(r.x, 1); eq(r.y, 0);
});

test('stops on sticky cell', () => {
  // . S . .  — sticky at col 1
  const level = makeLevel(['.S..']);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0);
  eq(r.x, 1); eq(r.y, 0);
});

test('stops at goal cell', () => {
  const level = makeLevel(['....'], { goal: { x: 2, y: 0 } });
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0);
  eq(r.x, 2); eq(r.y, 0);
});

test('oneway blocks slide from wrong direction, sets blockedByOneway', () => {
  // . < . .  — ONEWAY_LEFT at col 1; player slides right (dx=1) → blocked before col 1
  const level = makeLevel(['.<..']);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0);
  eq(r.x, 0); eq(r.y, 0);
  assert(r.blockedByOneway !== null, 'blockedByOneway should be set');
  eq(r.blockedByOneway.x, 1);
});

test('oneway passes slide in the allowed direction', () => {
  // . > . .  — ONEWAY_RIGHT at col 1; player slides right (dx=1) → passes through to boundary
  const level = makeLevel(['.>..']);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0);
  eq(r.x, 3); eq(r.y, 0);
  eq(r.blockedByOneway, null);
});

test('solid crumble blocks slide and sets crumble result', () => {
  // . . C .  — crumble at col 2
  const level = makeLevel(['..C.']);
  const tm = buildToggleMap(level.cells);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0, tm, 0);
  eq(r.x, 1); eq(r.y, 0);
  assert(r.crumble !== null, 'crumble should be set');
  eq(r.crumble.x, 2); eq(r.crumble.y, 0);
  eq(r.crumble.toggleIdx, 0);
});

test('broken crumble (toggle active) is treated as empty', () => {
  // . . C .  — crumble at col 2, toggle 0 active (already broken)
  const level = makeLevel(['..C.']);
  const tm = buildToggleMap(level.cells);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0, tm, 0b1);
  eq(r.x, 3); eq(r.y, 0);
  eq(r.crumble, null);
});

test('gear waypoint (gearSet) acts as sticky — player stops on it', () => {
  // . . . .  — gear placed at col 2 (flat index 2)
  const level = makeLevel(['....']);
  const gearSet = new Set([2]);
  const r = slidePlayer(level, { x: 0, y: 0 }, 1, 0, null, 0, gearSet);
  eq(r.x, 2); eq(r.y, 0);
});

test('sliding up from start column enters the boat (y = -1)', () => {
  // . . . . .  — start column is x=2; player at (2,0) slides up → enters boat
  const level = makeLevel(['.....'], { start: { x: 2, y: -1 }, goal: { x: 4, y: 0 } });
  const r = slidePlayer(level, { x: 2, y: 0 }, 0, -1);
  eq(r.x, 2); eq(r.y, -1);
});

test('sliding up from non-start column does not enter the boat', () => {
  const level = makeLevel(['.....'], { start: { x: 2, y: -1 }, goal: { x: 4, y: 0 } });
  // Player at col 0, slides up — hits boundary, stays
  const r = slidePlayer(level, { x: 0, y: 0 }, 0, -1);
  eq(r.x, 0); eq(r.y, 0);
});

// ── generator.js ──────────────────────────────────────────────────────────────

group('generator');

test('same seed produces identical cells', () => {
  const a = generateLevel(9, 9, { seed: 42 });
  const b = generateLevel(9, 9, { seed: 42 });
  assert(a.cells.every((v, i) => v === b.cells[i]), 'cells differ between identical-seed runs');
});

test('different seeds produce different cells', () => {
  const a = generateLevel(9, 9, { seed: 1 });
  const b = generateLevel(9, 9, { seed: 999 });
  assert(!a.cells.every((v, i) => v === b.cells[i]), 'seeds 1 and 999 produced identical cells');
});

test('output has correct width and height', () => {
  const level = generateLevel(7, 5, { seed: 0 });
  eq(level.width, 7);
  eq(level.height, 5);
  eq(level.cells.length, 35);
});

test('start is above the grid at y = -1 with a valid column', () => {
  for (const seed of [0, 42, 100]) {
    const level = generateLevel(9, 9, { seed });
    eq(level.start.y, -1);
    assert(level.start.x >= 0 && level.start.x < level.width, `seed ${seed}: start.x out of bounds`);
  }
});

test('goal cell is not a wall or crumble', () => {
  const forbidden = new Set([CellType.WALL, CellType.CRUMBLE]);
  for (const seed of [0, 42, 100, 200, 500]) {
    const { cells, goal, width } = generateLevel(9, 9, { seed });
    const cell = cells[goal.y * width + goal.x];
    assert(!forbidden.has(cell), `seed ${seed}: goal cell type ${cell} is forbidden`);
  }
});

test('level id is preserved', () => {
  eq(generateLevel(9, 9, { seed: 0, id: 7 }).id, 7);
});

test('effectiveCogs is at least 1', () => {
  for (const seed of [0, 42, 100, 200]) {
    const { effectiveCogs } = generateLevel(9, 9, { seed });
    assert(effectiveCogs >= 1, `seed ${seed}: effectiveCogs ${effectiveCogs} < 1`);
  }
});

test('effectiveChainLength is positive', () => {
  for (const seed of [0, 42, 100, 200]) {
    const { effectiveChainLength } = generateLevel(9, 9, { seed });
    assert(effectiveChainLength >= 1, `seed ${seed}: effectiveChainLength ${effectiveChainLength} < 1`);
  }
});

test('depths, chainLengths, difficulties arrays cover all cells', () => {
  const level = generateLevel(9, 9, { seed: 42 });
  const n = level.width * level.height;
  eq(level.depths.length, n);
  eq(level.chainLengths.length, n);
  eq(level.difficulties.length, n);
});

test('goal cell has valid depth and difficulty', () => {
  for (const seed of [0, 42, 100]) {
    const level = generateLevel(9, 9, { seed });
    const flat  = level.goal.y * level.width + level.goal.x;
    assert(level.depths[flat] >= 0,       `seed ${seed}: depths[goal] not set`);
    assert(level.difficulties[flat] >= 0, `seed ${seed}: difficulties[goal] not set`);
  }
});

// ── Render ────────────────────────────────────────────────────────────────────

const list    = document.getElementById('results');
const summary = document.getElementById('summary');
const passed  = results.filter(r => r.pass).length;
const failed  = results.filter(r => !r.pass).length;

let prevGroup = null;
for (const r of results) {
  if (r.group !== prevGroup) {
    prevGroup = r.group;
    const li = document.createElement('li');
    li.className = 'group';
    li.textContent = r.group;
    list.appendChild(li);
  }
  const li = document.createElement('li');
  li.className = `result ${r.pass ? 'pass' : 'fail'}`;
  li.textContent = (r.pass ? '✓  ' : '✗  ') + r.name;
  list.appendChild(li);
  if (!r.pass && r.msg) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = r.msg;
    list.appendChild(msg);
  }
}

summary.className = failed > 0 ? 'fail' : 'pass';
summary.textContent = failed > 0
  ? `✗  ${failed} failed · ${passed} passed`
  : `✓  All ${passed} passed`;
