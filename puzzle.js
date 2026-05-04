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
// Topological changes to a level (crumble breaks, doors opening, etc.) are
// modelled as "toggles".  Each toggle has an index (0–30) and a bit in a
// 31-bit integer called the worldState.  A set bit means the toggle is
// "active" (e.g. the crumble at that position has been broken).
//
// This lets the BFS / solver treat every distinct (playerPos, worldState) pair
// as a separate node — i.e. "parallel universes" — without mutating the level.
// Adding new types of topological change (keys, doors, alternating blocks, …)
// only requires assigning them toggle indices and checking the bit here.

/**
 * Scan a level's cells and assign a toggle index to every stateful cell.
 * Currently: CRUMBLE cells.  Add more types here as they are introduced.
 *
 * @param {Uint8Array} cells
 * @returns {Map<number, number>}  flatIndex → toggleIndex
 */
export function buildToggleMap(cells) {
  const map = new Map();
  let count = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === CellType.CRUMBLE) {
      map.set(i, count++);
    }
    // Future: keys, doors, alternating blocks, etc.
    // if (cells[i] === CellType.DOOR) map.set(i, count++);
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
 * Rules:
 *   WALL       — stop before the cell
 *   CRUMBLE    — stop before the cell when solid; pass through when its toggle
 *                is active in worldState (i.e. already broken)
 *   ONEWAY_*   — stop before the cell if moving in the wrong direction
 *   STICKY     — move onto the cell, then stop
 *
 * @param {object} level     - { width, height, cells: Uint8Array, goal? }
 * @param {{x:number, y:number}} pos
 * @param {number} dx
 * @param {number} dy
 * @param {Map<number,number>} [toggleMap]  - from buildToggleMap(); null = no toggles
 * @param {number}             [worldState] - bitmask of active toggles (default 0)
 * @returns {{ x:number, y:number, crumble:{ x:number, y:number, toggleIdx:number }|null }}
 *   crumble is non-null when the slide was stopped by a solid crumble cell.
 *   toggleIdx is the toggle index for that crumble (so the caller can compute
 *   the next worldState: newWS = worldState | (1 << toggleIdx)).
 */
export function slidePlayer(level, pos, dx, dy, toggleMap = null, worldState = 0) {
  const { width, height, cells } = level;
  let x = pos.x;
  let y = pos.y;
  let crumble = null;

  const DIR_NAME = { '1,0': 'RIGHT', '-1,0': 'LEFT', '0,1': 'DOWN', '0,-1': 'UP' };
  const dirLabel = DIR_NAME[`${dx},${dy}`] ?? `(${dx},${dy})`;
  const steps = [];

  while (true) {
    const nx = x + dx;
    const ny = y + dy;

    // Stop at grid boundary
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      steps.push(`(${x},${y}) — boundary`);
      break;
    }

    const flatIdx = ny * width + nx;
    const cell    = cells[flatIdx];

    // Stop before a wall
    if (cell === CellType.WALL) {
      steps.push(`(${x},${y}) — wall at (${nx},${ny})`);
      break;
    }

    // Crumble: solid unless its toggle is active (already broken)
    if (cell === CellType.CRUMBLE) {
      if (!isToggleActive(toggleMap, worldState, flatIdx)) {
        // Still solid — stop before it and record for the caller
        const toggleIdx = toggleMap ? toggleMap.get(flatIdx) : undefined;
        crumble = { x: nx, y: ny, toggleIdx };
        steps.push(`(${x},${y}) — crumble at (${nx},${ny})`);
        break;
      }
      // Broken — treat as empty and keep sliding (fall through)
    }

    // Stop before a one-way cell moving in the wrong direction
    if (isOneway(cell) && !onewayAllows(cell, dx, dy)) {
      steps.push(`(${x},${y}) — oneway blocked at (${nx},${ny})`);
      break;
    }

    // Move onto the cell
    x = nx;
    y = ny;

    // Stop on the goal (acts like sticky — slide through triggers it)
    if (level.goal && x === level.goal.x && y === level.goal.y) {
      steps.push(`(${x},${y}) — goal`);
      break;
    }

    // Stop after landing on a sticky cell
    if (cell === CellType.STICKY) {
      steps.push(`(${x},${y}) — sticky stop`);
      break;
    }

    steps.push(`(${x},${y})`);
  }

  const result = { x, y, crumble };
  const moved = result.x !== pos.x || result.y !== pos.y;
  console.log(
    `[move] ${dirLabel}  (${pos.x},${pos.y}) → (${result.x},${result.y})` +
    (crumble ? `  crumble=(${crumble.x},${crumble.y}) toggleIdx=${crumble.toggleIdx}` : '') +
    (moved ? `  steps: ${steps.join(' → ')}` : '  (no movement)')
  );

  return result;
}
