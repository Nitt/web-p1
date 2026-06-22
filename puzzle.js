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
  TELEPORTER:  10,   // paired cells; player slides into entry and continues from paired exit
  HOOK:        11,   // permanent gear anchor: stops the player (like sticky), bending from it costs 0 gears
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
// Topological changes to a level (crumble breaks) are modelled as "toggles".
// Each toggle has an index (0–30) and a bit in a 31-bit integer called the
// worldState.  A set bit means the toggle is "active" (e.g. the crumble broke).
//
// Cells that ACTIVATE a toggle: CRUMBLE (auto-breaks when stopped against).
//
// Adding new types of topological change only requires:
//   1. Assigning toggle indices in buildToggleMap
//   2. Checking the bit in slidePlayer / generator _slidePath

/**
 * Scan a level's cells and assign a toggle index to every activating cell.
 * Currently: CRUMBLE cells only (in flat scan order).
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
 *   ONEWAY_*    — stop before the cell if moving in the wrong direction
 *   STICKY      — move onto the cell, then stop
 *
 * @param {object} level      - { width, height, cells, goal? }
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
 *   crumble: { x, y, toggleIdx } | null,
 * }}
 *   crumble — non-null when the slide stopped before a solid crumble.
 *   Caller computes the new worldState: newWS = worldState | (1 << toggleIdx)
 */
export function slidePlayer(level, pos, dx, dy, toggleMap = null, worldState = 0, gearSet = null) {
  const { width, height, cells } = level;
  let x = pos.x;
  let y = pos.y;
  let crumble          = null;
  let blockedByOneway  = null;
  let teleportCrossing    = null;
  let virtualLanding      = null; // cell just past the last traversable one-way on this slide
  let skipTeleportEntry   = -1; // flat index of teleport entry to skip after teleporting

  while (true) {
    const nx = x + dx;
    const ny = y + dy;

    // Allow sliding up into the boat entry (one row above the grid at the start column).
    if (ny === -1 && nx === level.start.x && dx === 0 && dy === -1) {
      x = nx; y = ny;
      break;
    }

    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      break;
    }

    const flatIdx = ny * width + nx;
    const cell    = cells[flatIdx];

    // ── STOP before re-entering the teleport entry we just came from ────────
    // After A→B teleport, continuing in direction X may loop back toward A.
    // Break WITHOUT stepping onto A — landing on a teleporter cell would let
    // the solver use it as a bend point (90° turn at a teleporter), which is
    // physically impossible since entering a teleporter always teleports you.
    if (flatIdx === skipTeleportEntry) {
      skipTeleportEntry = -1;
      break;
    }

    // ── WALL ──────────────────────────────────────────────────────────────
    if (cell === CellType.WALL) {
      break;
    }

    // ── CRUMBLE: solid unless its toggle is active (already broken) ────────
    if (cell === CellType.CRUMBLE) {
      if (!isToggleActive(toggleMap, worldState, flatIdx)) {
        const toggleIdx = toggleMap ? toggleMap.get(flatIdx) : undefined;
        crumble = { x: nx, y: ny, toggleIdx };
        break;
      }
      // Broken — treat as empty, continue sliding
    }

    // ── ONEWAY: stop if approaching from the wrong direction ──────────────
    if (isOneway(cell) && !onewayAllows(cell, dx, dy)) {
      blockedByOneway = { x: nx, y: ny };
      break;
    }
    if (isOneway(cell)) {  // allowed direction — cell just past it is a virtual landing candidate
      const vx = nx + dx, vy = ny + dy;
      if (vx >= 0 && vx < width && vy >= 0 && vy < height) {
        virtualLanding = { x: vx, y: vy };
      }
    }

    // ── TELEPORTER: enter entry cell, jump to exit, continue sliding ───────
    if (cell === CellType.TELEPORTER) {
      x = nx; y = ny;
      const exitFlat = level.teleporterMap?.get(flatIdx);
      if (exitFlat !== undefined) {
        const exitX = exitFlat % width;
        const exitY = Math.floor(exitFlat / width);
        teleportCrossing = { entryX: x, entryY: y, exitX, exitY };
        skipTeleportEntry = flatIdx; // skip re-entering this entry on the same slide
        x = exitX; y = exitY;
        // Check stop conditions at the exit cell
        if (level.goal && x === level.goal.x && y === level.goal.y) break;
        const exitCell = cells[y * width + x];
        if (exitCell === CellType.STICKY || exitCell === CellType.HOOK) break;
        if (gearSet && gearSet.has(y * width + x)) break;
        continue; // continue sliding from exit in the same direction
      }
      // No exit mapped — treat as a stop
      break;
    }

    // ── Move onto the cell ────────────────────────────────────────────────
    x = nx;
    y = ny;

    if (level.goal && x === level.goal.x && y === level.goal.y) {
      break;
    }

    if (cell === CellType.STICKY || cell === CellType.HOOK) {
      break;
    }

    // Gear waypoints act like stickies: stop on landing rather than sliding through
    if (gearSet && gearSet.has(y * width + x)) {
      break;
    }
  }

  // Discard virtual landing if it coincides with the actual landing (redundant node).
  if (virtualLanding && virtualLanding.x === x && virtualLanding.y === y) virtualLanding = null;
  return { x, y, crumble, blockedByOneway, teleportCrossing, virtualLanding };
}
