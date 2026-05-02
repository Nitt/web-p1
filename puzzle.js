// Cell types — extend here as new mechanics are added
export const CellType = {
  EMPTY: 0,
  WALL:  1,
  // STICKY:     2,
  // ONEWAY:     3,
  // TELEPORTER: 4,
};

/**
 * Compute the cell the player slides to when moving in direction (dx, dy).
 * Pure function — no side effects.
 *
 * @param {object} level  - { width, height, cells: Uint8Array, start, goal }
 * @param {{x:number, y:number}} pos
 * @param {number} dx
 * @param {number} dy
 * @returns {{x:number, y:number}}
 */
export function slidePlayer(level, pos, dx, dy) {
  const { width, height, cells } = level;
  let x = pos.x;
  let y = pos.y;

  while (true) {
    const nx = x + dx;
    const ny = y + dy;

    // Stop at grid boundary
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;

    // Stop before a wall
    if (cells[ny * width + nx] === CellType.WALL) break;

    x = nx;
    y = ny;
  }

  return { x, y };
}
