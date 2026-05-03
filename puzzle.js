// Cell types — must match the values written by generator.js
export const CellType = {
  EMPTY:        0,
  WALL:         1,
  STICKY:       2,   // player stops on this cell (not before it)
  ONEWAY_LEFT:  3,   // passable only when moving left  (dx=-1)
  ONEWAY_RIGHT: 4,   // passable only when moving right (dx=+1)
  ONEWAY_UP:    5,   // passable only when moving up    (dy=-1)
  ONEWAY_DOWN:  6,   // passable only when moving down  (dy=+1)
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

/**
 * Compute the cell the player slides to when moving in direction (dx, dy).
 * Pure function — no side effects.
 *
 * Rules:
 *   WALL       — stop before the cell (unchanged)
 *   ONEWAY_*   — stop before the cell if moving in the wrong direction
 *   STICKY     — move onto the cell, then stop
 *
 * @param {object} level  - { width, height, cells: Uint8Array }
 * @param {{x:number, y:number}} pos
 * @param {number} dx
 * @param {number} dy
 * @returns {{x:number, y:number}}
 */
export function slidePlayer(level, pos, dx, dy) {
  const { width, height, cells } = level;
  let x = pos.x;
  let y = pos.y;

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

    const cell = cells[ny * width + nx];

    // Stop before a wall
    if (cell === CellType.WALL) {
      steps.push(`(${x},${y}) — wall at (${nx},${ny})`);
      break;
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

  const result = { x, y };
  const moved = result.x !== pos.x || result.y !== pos.y;
  console.log(
    `[move] ${dirLabel}  (${pos.x},${pos.y}) → (${result.x},${result.y})` +
    (moved ? `  steps: ${steps.join(' → ')}` : '  (no movement)')
  );

  return result;
}
