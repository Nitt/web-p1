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
  TELEPORTER:   10,  // instantly moves the player to the paired teleporter; chain jump is free
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
 * BFS reachability check: can the player reach the goal from (pos, worldState)?
 * Ignores gear budget — only tests topological reachability (walls, one-ways,
 * crumbles, keys, doors).  Used for dead-end detection after each move.
 *
 * @param {object} level
 * @param {{x,y}} pos
 * @param {number} worldState
 * @param {Map<number,number>} toggleMap
 * @returns {boolean}
 */
export function canReachGoal(level, pos, worldState, toggleMap) {
  const { width, height, goal } = level;
  if (!goal) return true;
  const DIRS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  // Key uses (y+1) so the boat row (y=-1) maps to 0 — prevents collision with
  // the bottom grid row when ws differs by 1.
  const key = (x, y, ws) => ws * width * (height + 1) + (y + 1) * width + x;
  const visited = new Set();
  const queue = [{ x: pos.x, y: pos.y, ws: worldState }];
  let head = 0;
  visited.add(key(pos.x, pos.y, worldState));

  while (head < queue.length) {
    const { x, y, ws } = queue[head++];
    if (x === goal.x && y === goal.y) return true;

    for (const { dx, dy } of DIRS) {
      const r = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws, null, true, level.teleporterMap);
      let nws = ws;
      if (r.crumble      ?.toggleIdx !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected ?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);

      const k = key(r.x, r.y, nws);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push({ x: r.x, y: r.y, ws: nws });
      }
    }
  }
  return false;
}

// Returns true if the player can reach ANY of the given target positions.
// Used for dead-end detection when uncollected keys exist: not a dead end if
// either the goal or any key is still reachable.
export function canReachAnyOf(level, pos, targets, worldState, toggleMap) {
  if (!targets || targets.length === 0) return true;
  const { width, height } = level;
  const flatTargets = new Set(targets.map(t => t.y * width + t.x));
  const DIRS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  const stateKey = (x, y, ws) => ws * width * (height + 1) + (y + 1) * width + x;
  const visited = new Set([stateKey(pos.x, pos.y, worldState)]);
  const queue = [{ x: pos.x, y: pos.y, ws: worldState }];
  let head = 0;

  while (head < queue.length) {
    const { x, y, ws } = queue[head++];
    if (flatTargets.has(y * width + x)) return true;

    for (const { dx, dy } of DIRS) {
      const r = slidePlayer(level, { x, y }, dx, dy, toggleMap, ws, null, true, level.teleporterMap);
      let nws = ws;
      if (r.crumble      ?.toggleIdx !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected ?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);
      const k = stateKey(r.x, r.y, nws);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push({ x: r.x, y: r.y, ws: nws });
      }
    }
  }
  return false;
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
export function slidePlayer(level, pos, dx, dy, toggleMap = null, worldState = 0, gearSet = null, maxSlideLength = Infinity, teleporterMap = null) {
  const { width, height, cells } = level;
  let x = pos.x;
  let y = pos.y;
  let crumble         = null;
  let keyCollected    = null;
  let blockedByOneway = null;
  let stepsTaken      = 0;
  const usedTeleporters = teleporterMap ? new Set() : null;

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

    // Stop if chain length budget is exhausted.
    if (stepsTaken >= maxSlideLength) break;

    const flatIdx = ny * width + nx;
    const cell    = cells[flatIdx];

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

    // ── KEY: collect on first landing; treat as empty once collected ───────
    if (cell === CellType.KEY) {
      const toggleIdx = toggleMap ? toggleMap.get(flatIdx) : undefined;
      const collected = toggleIdx !== undefined && (worldState & (1 << toggleIdx)) !== 0;
      if (!collected) {
        x = nx; y = ny;
        stepsTaken++;
        keyCollected = { x, y, toggleIdx };
        break;
      }
      // Already collected — treat as empty, fall through to normal move
    }

    // ── DOOR: locked until its required toggle is active ──────────────────
    if (cell === CellType.DOOR) {
      const req = level.doorRequirements?.get(flatIdx);
      const open = req !== undefined && (worldState & (1 << req)) !== 0;
      if (!open) {
        break;
      }
      // Open — treat as empty, fall through
    }

    // ── ONEWAY: stop if approaching from the wrong direction ──────────────
    if (isOneway(cell) && !onewayAllows(cell, dx, dy)) {
      blockedByOneway = { x: nx, y: ny };
      break;
    }

    // ── Move onto the cell ────────────────────────────────────────────────
    x = nx;
    y = ny;
    stepsTaken++;

    // TELEPORTER: jump to partner and continue sliding from exit (free — no extra step)
    if (usedTeleporters && cell === CellType.TELEPORTER) {
      const flatIdx    = y * width + x;
      const partnerIdx = teleporterMap.get(flatIdx);
      if (partnerIdx !== undefined && !usedTeleporters.has(flatIdx)) {
        usedTeleporters.add(flatIdx);
        usedTeleporters.add(partnerIdx);
        x = partnerIdx % width;
        y = Math.floor(partnerIdx / width);
        continue;
      }
    }

    if (level.goal && x === level.goal.x && y === level.goal.y) {
      break;
    }

    if (cell === CellType.STICKY) {
      break;
    }

    // Gear waypoints act like stickies: stop on landing rather than sliding through
    if (gearSet && gearSet.has(y * width + x)) {
      break;
    }
  }

  return { x, y, crumble, keyCollected, blockedByOneway };
}
