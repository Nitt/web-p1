// Cell types — must match the values written by generator.js
export const CellType = {
  EMPTY:        0,
  WALL:         1,
  STICKY:       2,   // player stops on this cell (not before it)
  ONEWAY_LEFT:  3,   // passable only when moving left  (dx=-1)
  ONEWAY_RIGHT: 4,   // passable only when moving right (dx=+1)
  ONEWAY_UP:    5,   // passable only when moving up    (dy=-1)
  ONEWAY_DOWN:  6,   // passable only when moving down  (dy=+1)
  CRUMBLE:      7,   // acts like a wall, but crumbles when the player stops against it
  KEY:          8,   // player stops on it and collects it (activates its toggle)
  DOOR:         9,   // blocks like a wall; passable once the paired key's toggle is active
};

/** Returns true for any one-way cell type. */
export function isOneway(type) {
  return type >= CellType.ONEWAY_LEFT && type <= CellType.ONEWAY_DOWN;
}

/**
 * Returns true if the player moving in (dx, dy) is allowed through a one-way cell.
 * @param {number} type  - a CellType.ONEWAY_* value
 */
export function onewayAllows(type, dx, dy) {
  switch (type) {
    case CellType.ONEWAY_LEFT:  return dx === -1 && dy === 0;
    case CellType.ONEWAY_RIGHT: return dx ===  1 && dy === 0;
    case CellType.ONEWAY_UP:    return dx ===  0 && dy === -1;
    case CellType.ONEWAY_DOWN:  return dx ===  0 && dy ===  1;
    default: return true;
  }
}

// ── World-state / toggle system ───────────────────────────────────────────────
//
// Topological changes to a level (crumble breaks, key collection, door opening,
// …) are modelled as "toggles".  Each toggle has an index (0–30) and a bit in a
// 31-bit integer called the worldState.  A set bit means the toggle is "active"
// (e.g. the crumble broke, or the key was collected).
//
// Cells that ACTIVATE a toggle: CRUMBLE (auto-breaks when stopped against),
//                               KEY (collected when player lands on it).
// Cells that REQUIRE a toggle:  DOOR (passable only after paired key collected).
//
// Adding new types of topological change only requires:
//   1. Assigning toggle indices in buildToggleMap
//   2. Checking the bit in slidePlayer / generator _slidePath

/**
 * Scan a level's cells and assign a toggle index to every activating cell.
 * Currently: CRUMBLE and KEY cells (in flat scan order).
 *
 * @param {Uint8Array} cells
 * @returns {Map<number, number>}  flatIndex → toggleIndex
 */
export function buildToggleMap(cells) {
  const map = new Map();
  let count = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === CellType.CRUMBLE || cells[i] === CellType.KEY) {
      map.set(i, count++);
    }
    // Future: alternating blocks, switches, etc.
  }
  return map;
}

/**
 * Returns true if the toggle for the cell at flatIndex is active in worldState.
 * @param {Map<number,number>} toggleMap
 * @param {number} worldState
 * @param {number} flatIndex
 */
export function isToggleActive(toggleMap, worldState, flatIndex) {
  const idx = toggleMap.get(flatIndex);
  return idx !== undefined && (worldState & (1 << idx)) !== 0;
}

/**
 * Compute the cell the player slides to when moving in direction (dx, dy).
 * Pure function — no side effects.
 *
 * Cell behaviour:
 *   WALL        — stop before the cell
 *   CRUMBLE     — stop before the cell when solid; pass through when its toggle
 *                 is active in worldState (i.e. already broken)
 *   KEY         — move onto it and stop (collecting it) when its toggle is NOT
 *                 active; treat as empty (slide through) when already collected
 *   DOOR        — stop before it when its required toggle is NOT active (locked);
 *                 treat as empty when the required toggle IS active (open)
 *   ONEWAY_*    — stop before the cell if moving in the wrong direction
 *   STICKY      — move onto the cell, then stop
 *
 * @param {object} level      - { width, height, cells, goal?, doorRequirements? }
 * @param {{x,y}}  pos
 * @param {number} dx
 * @param {number} dy
 * @param {Map<number,number>} [toggleMap]  - from buildToggleMap(); null = no toggles
 * @param {number}             [worldState] - bitmask of active toggles (default 0)
 * @param {Set<number>}        [gearSet]    - flat indices of placed gear waypoints; player stops on them like sticky
 *
 * @returns {{
 *   x: number,
 *   y: number,
 *   crumble:      { x, y, toggleIdx } | null,
 *   keyCollected: { x, y, toggleIdx } | null,
 * }}
 *   crumble      — non-null when the slide stopped before a solid crumble.
 *   keyCollected — non-null when the player landed on an uncollected key.
 *   In both cases the caller computes the new worldState:
 *     newWS = worldState | (1 << toggleIdx)
 */
export function slidePlayer(level, pos, dx, dy, toggleMap = null, worldState = 0, gearSet = null) {
  const { width, height, cells } = level;
  let x = pos.x;
  let y = pos.y;
  let crumble      = null;
  let keyCollected = null;

  const DIR_NAME = { '1,0': 'RIGHT', '-1,0': 'LEFT', '0,1': 'DOWN', '0,-1': 'UP' };
  const dirLabel = DIR_NAME[`${dx},${dy}`] ?? `(${dx},${dy})`;
  const steps = [];

  while (true) {
    const nx = x + dx;
    const ny = y + dy;

    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      steps.push(`(${x},${y}) — boundary`);
      break;
    }

    const flatIdx = ny * width + nx;
    const cell    = cells[flatIdx];

    // ── WALL ──────────────────────────────────────────────────────────────
    if (cell === CellType.WALL) {
      steps.push(`(${x},${y}) — wall at (${nx},${ny})`);
      break;
    }

    // ── CRUMBLE: solid unless its toggle is active (already broken) ────────
    if (cell === CellType.CRUMBLE) {
      if (!isToggleActive(toggleMap, worldState, flatIdx)) {
        const toggleIdx = toggleMap ? toggleMap.get(flatIdx) : undefined;
        crumble = { x: nx, y: ny, toggleIdx };
        steps.push(`(${x},${y}) — crumble at (${nx},${ny})`);
        break;
      }
      // Broken — treat as empty, continue sliding
    }

    // ── KEY: collect on first landing; treat as empty once collected ───────
    if (cell === CellType.KEY) {
      const toggleIdx = toggleMap ? toggleMap.get(flatIdx) : undefined;
      const collected = toggleIdx !== undefined && (worldState & (1 << toggleIdx)) !== 0;
      if (!collected) {
        // Land on the key, collect it, stop here
        x = nx; y = ny;
        keyCollected = { x, y, toggleIdx };
        steps.push(`(${x},${y}) — key collected`);
        break;
      }
      // Already collected — treat as empty, fall through to normal move
    }

    // ── DOOR: locked until its required toggle is active ──────────────────
    if (cell === CellType.DOOR) {
      const req = level.doorRequirements?.get(flatIdx);
      const open = req !== undefined && (worldState & (1 << req)) !== 0;
      if (!open) {
        steps.push(`(${x},${y}) — door locked at (${nx},${ny})`);
        break;
      }
      // Open — treat as empty, fall through
    }

    // ── ONEWAY: stop if approaching from the wrong direction ──────────────
    if (isOneway(cell) && !onewayAllows(cell, dx, dy)) {
      steps.push(`(${x},${y}) — oneway blocked at (${nx},${ny})`);
      break;
    }

    // ── Move onto the cell ────────────────────────────────────────────────
    x = nx;
    y = ny;

    if (level.goal && x === level.goal.x && y === level.goal.y) {
      steps.push(`(${x},${y}) — goal`);
      break;
    }

    if (cell === CellType.STICKY) {
      steps.push(`(${x},${y}) — sticky stop`);
      break;
    }

    // Gear waypoints act like stickies: stop on landing rather than sliding through
    if (gearSet && gearSet.has(y * width + x)) {
      steps.push(`(${x},${y}) — gear stop`);
      break;
    }

    steps.push(`(${x},${y})`);
  }

  const result = { x, y, crumble, keyCollected };
  const moved  = result.x !== pos.x || result.y !== pos.y;
  console.log(
    `[move] ${dirLabel}  (${pos.x},${pos.y}) → (${result.x},${result.y})` +
    (crumble      ? `  crumble=(${crumble.x},${crumble.y}) toggleIdx=${crumble.toggleIdx}` : '') +
    (keyCollected ? `  key=(${keyCollected.x},${keyCollected.y}) toggleIdx=${keyCollected.toggleIdx}` : '') +
    (moved ? `  steps: ${steps.join(' → ')}` : '  (no movement)')
  );

  return result;
}
