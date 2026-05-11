import { CellType, isOneway } from './puzzle.js';

// Maps ONEWAY_* CellType values → data-dir attribute strings for CSS
const ONEWAY_DIR_ATTR = {
  [CellType.ONEWAY_LEFT]:  'left',
  [CellType.ONEWAY_RIGHT]: 'right',
  [CellType.ONEWAY_UP]:    'up',
  [CellType.ONEWAY_DOWN]:  'down',
};

// ── Speed control ─────────────────────────────────────────────────────────────
// Adjust _speedMult to slow down or speed up the whole game.
// 1 = normal, 2 = half speed, 0.5 = double speed, etc.
let _speedMult = 1;
export function setSpeedMultiplier(m) { _speedMult = Math.max(0.1, m); }
export function getSpeedMultiplier()  { return _speedMult; }

// ms per grid cell of travel (base value × multiplier)
const SPEED_MS_PER_CELL_BASE = 80;
const speedMs = () => SPEED_MS_PER_CELL_BASE * _speedMult;

let gridEl = null;
let playerEl = null;
let goalEl = null;
let chainSvgEl = null;
let counterSpan = null;
let boatEl = null;
let waterlineEl = null;
let skyEl = null;
let containerEl = null;
let _currentLevel = null;
// Tracks the last pixel position written to the player overlay.
// Used as the authoritative animation start so there is never a
// discrepancy between the visual position and the animation origin.
let playerPx = { x: 0, y: 0 };
// Stores the last drawChain arguments so the animation loop can redraw each frame.
let _chainState = null;
// Gear spin state — driven by JS so rotation is continuous despite per-frame DOM recreation.
let _chainSpinning  = false;
let _playerAnimToken = 0;
let _spinDirection  = 1;   // 1 = clockwise, -1 = counterclockwise
let _spinStartTime  = 0;
let _spinAngleBase  = 0;   // accumulated signed angle (degrees) at last stop
const SPIN_PERIOD_MS_BASE = 500;
const spinPeriodMs = () => SPIN_PERIOD_MS_BASE * _speedMult;
const CHAIN_LINK_OUTER_RX = 17;   // half long-axis  — outer ring
const CHAIN_LINK_OUTER_RY = 10.5; // half short-axis — outer ring
const CHAIN_LINK_INNER_RX = 10.5; // half long-axis  — hole
const CHAIN_LINK_INNER_RY = 5.3;  // half short-axis — hole
// Pitch = 1.4×outerRX → links overlap ~20% on each end
const CHAIN_LINK_PITCH    = CHAIN_LINK_OUTER_RX * 1.4;

/**
 * Build (or rebuild) the grid DOM from a level.
 * @param {HTMLElement} container
 * @param {object} level
 */
export function buildGrid(container, level) {
  container.innerHTML = '';
  container.style.setProperty('--cols', level.width);
  container.style.setProperty('--rows', level.height);

  containerEl = container;
  _currentLevel = level;

  gridEl = document.createElement('div');
  gridEl.className = 'grid';
  container.appendChild(gridEl);

  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      // Hide top-row wall cells (entry tunnel sides) — boat/waterline covers them.
      // The center entry cell (level.start.x) is kept visible for the chain.
      if (y === 0 && x !== level.start.x) cell.classList.add('entry-wall');
      const type = level.cells[y * level.width + x];
      if (type === CellType.WALL)    cell.dataset.type = 'wall';
      if (type === CellType.STICKY)  cell.dataset.type = 'sticky';
      if (type === CellType.CRUMBLE) cell.dataset.type = 'crumble';
      if (type === CellType.KEY)     cell.dataset.type = 'key';
      if (type === CellType.DOOR)    cell.dataset.type = 'door';
      if (isOneway(type)) {
        cell.dataset.type = 'oneway';
        cell.dataset.dir  = ONEWAY_DIR_ATTR[type];
      }
      const coord = document.createElement('span');
      coord.className = 'cell-coord';
      coord.textContent = `${x},${y}`;
      cell.appendChild(coord);

      if (level.depths) {
        const d = level.depths[y * level.width + x];
        if (d >= 0) {
          const depth = document.createElement('span');
          depth.className = 'cell-depth';
          depth.textContent = d;
          cell.appendChild(depth);
        }
      }

      if (level.difficulties) {
        const d = level.difficulties[y * level.width + x];
        if (d >= 0) {
          const diff = document.createElement('span');
          diff.className = 'cell-difficulty';
          diff.textContent = Number.isInteger(d) ? d : d.toFixed(1);
          cell.appendChild(diff);
        }
      }

      if (level.visitedDirs) {
        const dirs = level.visitedDirs.get(y * level.width + x);
        if (dirs) {
          const ARROW = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
          for (const dir of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
            if (dirs.has(dir)) {
              const arrow = document.createElement('span');
              arrow.className = 'cell-dir';
              arrow.dataset.dir = dir.toLowerCase();
              arrow.textContent = ARROW[dir];
              cell.appendChild(arrow);
            }
          }
        }
      }

      gridEl.appendChild(cell);
    }
  }

  // Mark start cell
  const startCell = gridEl.children[level.start.y * level.width + level.start.x];
  if (startCell) startCell.dataset.type = 'start';

  // Chain SVG overlay (below player/goal)
  chainSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chainSvgEl.setAttribute('class', 'chain-svg');
  gridEl.appendChild(chainSvgEl);

  // Goal marker (overlay)
  goalEl = document.createElement('div');
  goalEl.className = 'goal';
  gridEl.appendChild(goalEl);
  _placeOverlay(goalEl, level.goal.x, level.goal.y, level);

  // Player (overlay)
  playerEl = document.createElement('div');
  playerEl.className = 'player';
  counterSpan = document.createElement('span');
  counterSpan.className = 'chain-counter';
  playerEl.appendChild(counterSpan);
  gridEl.appendChild(playerEl);

  // Sky, waterline, and boat overlays (appended to container, above the grid)
  skyEl = document.createElement('div');
  skyEl.className = 'sky-gradient';
  container.appendChild(skyEl);

  waterlineEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  waterlineEl.setAttribute('class', 'waterline-svg');
  container.appendChild(waterlineEl);

  boatEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  boatEl.setAttribute('class', 'boat-svg');
  boatEl.setAttribute('viewBox', '0 0 100 60');
  _drawBoat();
  container.appendChild(boatEl);

  // Initial positioning (deferred one frame so layout is complete)
  requestAnimationFrame(() => _updateBoatAndWaterline(level));
}

/**
 * Instantly place the player at a grid cell (no animation).
 */
export function placePlayer(pos, level) {
  _placeOverlay(playerEl, pos.x, pos.y, level);
}

/**
 * Animate the player from `from` to `to`, then call `onDone`.
 * @param {{x,y}} from
 * @param {{x,y}} to
 * @param {object} level
 * @param {()=>void} onDone
 */
export function animatePlayer(from, to, level, onDone) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (steps === 0) { onDone(); return; }

  const token = ++_playerAnimToken;
  const duration = steps * speedMs();
  const startTime = performance.now();
  // Snap visual position to the logical start cell before reading startPx.
  // This eliminates any accumulated desync between playerPx and state.playerPos
  // (e.g. caused by a previous no-op move or mid-animation resize), so the
  // new animation always originates from exactly the right pixel.
  // The Math.max(0,…) clamp on t means this snap never causes a backward jerk.
  _placeOverlay(playerEl, from.x, from.y, level);
  const startPx = { ...playerPx };

  function frame(now) {
    if (token !== _playerAnimToken) return; // level changed — bail out
    const t = Math.max(0, Math.min((now - startTime) / duration, 1));
    // End position is recalculated every frame so mid-animation resizes stay correct.
    const endPx = _cellPixel(to.x, to.y, level);
    const cx = startPx.x + (endPx.x - startPx.x) * t;
    const cy = startPx.y + (endPx.y - startPx.y) * t;
    _setOverlayPixel(playerEl, cx, cy);
    if (_chainState) _redrawChain(cx, cy);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      onDone();
    }
  }
  requestAnimationFrame(frame);
}

/**
 * Re-place both overlays at their current logical positions.
 * Call this after a layout change (e.g. window resize).
 */
export function repositionOverlays(playerPos, level) {
  _placeOverlay(playerEl, playerPos.x, playerPos.y, level);
  _placeOverlay(goalEl,   level.goal.x, level.goal.y, level);
  _updateBoatAndWaterline(level);
}

/**
 * Play an explosion animation on the player, then call onDone.
 * @param {()=>void} onDone
 */
export function explodePlayer(onDone) {
  // Save the current positional transform as a CSS var, then remove the inline
  // style so the CSS animation (which references the var) can take full control.
  playerEl.style.setProperty('--player-transform', playerEl.style.transform);
  playerEl.style.transform = '';
  playerEl.classList.add('exploding');
  playerEl.addEventListener('animationend', function handler() {
    playerEl.classList.remove('exploding');
    playerEl.style.removeProperty('--player-transform');
    onDone();
  }, { once: true });
}

/**
 * Play a crumble animation on the cell at (x, y), then clear its appearance.
 */
export function removeCrumble(x, y, level) {
  const cellEl = gridEl.children[y * level.width + x];
  if (!cellEl) return;
  cellEl.classList.add('crumbling');
  cellEl.addEventListener('animationend', () => {
    cellEl.classList.remove('crumbling');
    delete cellEl.dataset.type;
  }, { once: true });
}

/**
 * Play a collect animation on the key at (x, y), then clear its appearance.
 */
export function removeKey(x, y, level) {
  const cellEl = gridEl.children[y * level.width + x];
  if (!cellEl) return;
  cellEl.classList.add('key-collected');
  cellEl.addEventListener('animationend', () => {
    cellEl.classList.remove('key-collected');
    delete cellEl.dataset.type;
  }, { once: true });
}

/**
 * Play an open animation on the door at (x, y), then update its appearance.
 */
export function openDoor(x, y, level) {
  const cellEl = gridEl.children[y * level.width + x];
  if (!cellEl) return;
  cellEl.dataset.type = 'door-open';
}

// ─── chain / gear rope ───────────────────────────────────────────────────────

/**
 * Redraw the chain SVG: rope from start cell → gear waypoints → player,
 * small circles at each waypoint, and a gear counter near the player.
 *
 * @param {{x,y}[]} gears        - ordered waypoint positions
 * @param {{x,y}}   playerPos    - current player position
 * @param {number}  gearsLeft    - remaining gear budget
 * @param {number}  totalGears   - starting gear budget
 * @param {object}  level        - current level (for start pos + dimensions)
 */
export function drawChain(gears, playerPos, gearsLeft, totalGears, level) {
  if (!chainSvgEl || !gridEl) return;
  const pp = _cellPixel(playerPos.x, playerPos.y, level);
  _chainState = { gears, gearsLeft, totalGears, level };
  _redrawChain(pp.x, pp.y);
}

/** Like drawChain but the tail endpoint is already in pixels (used for retract animation). */
export function drawChainWithPixelTail(gears, tailPx, gearsLeft, totalGears, level) {
  if (!chainSvgEl || !gridEl) return;
  _chainState = { gears, gearsLeft, totalGears, level };
  _redrawChain(tailPx.x, tailPx.y);
}

/** Expose pixel centre of a grid cell for use in retract animation. */
export function getCellPixel(x, y, level) {
  return _cellPixel(x, y, level);
}

/** Start or stop gear spinning. direction: 1 = clockwise, -1 = counterclockwise. */
export function setChainSpinning(spinning, direction = 1) {
  if (!spinning && _chainSpinning) {
    // Freeze current motion into the base so gears hold their angle when stopped.
    _spinAngleBase += ((performance.now() - _spinStartTime) / spinPeriodMs()) * 360 * _spinDirection;
  }
  if (spinning && !_chainSpinning) _spinStartTime = performance.now();
  _chainSpinning = spinning;
  _spinDirection = direction;
}

/**
 * Build a polyline approximating realistic chain routing through `rawPoints`.
 *
 * For start/end points the chain is offset tangentially with no gear wrap.
 *
 * Each interior gear has a localDir (+1 CW, -1 CCW) derived from the cross
 * product of its incoming and outgoing directions — the same logic used in
 * _redrawChain for the spin animation.  CW gears use -perp(d) = (d.y, -d.x)
 * as the chain side; CCW gears use +perp(d) = (-d.y, d.x).  This keeps the
 * chain offset consistent with the visible rotation direction.
 *
 */
function _buildChainPath(rawPoints, R, gearLerpT = 0) {
  if (rawPoints.length < 2) return rawPoints;

  const N = rawPoints.length;

  // Per-segment unit direction vectors.
  const dirs = [];
  for (let i = 1; i < N; i++) {
    const dx = rawPoints[i].x - rawPoints[i - 1].x;
    const dy = rawPoints[i].y - rawPoints[i - 1].y;
    const l = Math.hypot(dx, dy);
    dirs.push(l > 0.01 ? { x: dx / l, y: dy / l } : { x: 1, y: 0 });
  }

  // Per-point localDir: +1 = CW gear, -1 = CCW gear (same logic as _redrawChain).
  // CW gear  → chain on -perp(d) side  (d.y, -d.x)
  // CCW gear → chain on +perp(d) side  (-d.y, d.x)
  // Path is traversed player→boat (reversed). Both segment directions and cross
  // products flip sign, which cancels out in perp() — no negation needed.
  const localDirs = new Array(N).fill(1);
  if (N >= 3) {
    // Propagate prevLD in original placement order (boat→player), which in the reversed
    // array means iterating from index N-2 (first gear, nearest boat) down to 1 (nearest player).
    // This ensures straight-through gears inherit from the gear toward the boat, matching
    // _redrawChain's behaviour.
    //
    // dirs[N-2] points from the first gear toward the boat (reversed direction), so the
    // original boat→gear direction is its negation. The corrected seed formula is
    // Math.sign(|dx| + dy) instead of Math.sign(|dx| - dy).
    const seedDir = dirs[N - 2];
    let prevLD = Math.sign(Math.abs(seedDir.x) + seedDir.y) || 1;

    // When the player is standing on the nearest gear (rawPoints[0] ≈ rawPoints[1]),
    // dirs[0] is a degenerate fallback (1,0). At i=1 use dirs[1] on both sides of the
    // cross so it evaluates to 0 and falls back to the already-propagated prevLD.
    const firstSegDegenerate =
      Math.hypot(rawPoints[1].x - rawPoints[0].x, rawPoints[1].y - rawPoints[0].y) < 0.5;

    for (let i = N - 2; i >= 1; i--) {
      const dPrev = (i === 1 && firstSegDegenerate && dirs.length > 1) ? dirs[1] : dirs[i - 1];
      const cross = dPrev.x * dirs[i].y - dPrev.y * dirs[i].x;
      const ld = cross !== 0 ? Math.sign(cross) : prevLD;
      prevLD = ld;
      localDirs[i] = ld;
    }
    localDirs[0]     = localDirs[1];       // player inherits first gear (reversed)
    localDirs[N - 1] = localDirs[N - 2];   // boat inherits last gear (reversed)
  } else {
    // Only two points — use the single segment direction with the corrected formula.
    const s  = dirs[0];
    const ld = Math.sign(Math.abs(s.x) + s.y) || 1;
    localDirs[0] = localDirs[1] = ld;
  }

  // perp(d, ld): CW gear uses -perp, CCW gear uses +perp.
  const perp = (d, ld) => ld > 0
    ? { x: d.y, y: -d.x }   // -perp for CW
    : { x: -d.y, y: d.x };  // +perp for CCW

  // Point on the gear circle using the ld-aware perp.
  const tangentPt = (center, d, ld) => {
    const p = perp(d, ld);
    return { x: center.x + p.x * R, y: center.y + p.y * R };
  };

  // Approximate an arc of radius R centred at `center` from angle `a0` to `a1`
  // going in the signed direction indicated by `dAngle` (positive = CCW in math,
  // but SVG has y-down so positive dAngle sweeps CW visually — we just use a
  // consistent parameterisation here).
  const arcPoints = (center, a0, dAngle) => {
    const steps = Math.max(2, Math.ceil(Math.abs(dAngle) / (Math.PI / 6)));
    const pts = [];
    for (let s = 1; s <= steps; s++) {
      const a = a0 + dAngle * (s / steps);
      pts.push({ x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
    }
    return pts;
  };

  const out = [];

  // ── First point (player): centered, no offset ──
  out.push({ x: rawPoints[0].x, y: rawPoints[0].y });

  // ── Interior gear points ──
  for (let i = 1; i < N - 1; i++) {
    const d_in  = dirs[i - 1];
    const d_out = dirs[i];
    const center = rawPoints[i];
    const ld     = localDirs[i];

    // Straight-through: same direction (cross≈0, dot>0) — no cog, no arc wrap.
    // Just pass through the center so the chain runs straight.
    const cross_io = d_in.x * d_out.y - d_in.y * d_out.x;
    const dot_io   = d_in.x * d_out.x + d_in.y * d_out.y;
    if (Math.abs(cross_io) < 0.01 && dot_io > 0) {
      out.push({ x: center.x, y: center.y });
      continue;
    }

    // The gear nearest the player (index 1 in reversed path) lerps its tangent
    // offset from 0 (centered) to full R based on gearLerpT.
    // gearLerpT=0: chain connects to center (stationary); gearLerpT=1: full offset.
    if (i === 1 && gearLerpT < 1) {
      const t = gearLerpT;
      const entryFull = tangentPt(center, d_in,  ld);
      const exitFull  = tangentPt(center, d_out, ld);
      out.push({ x: center.x + (entryFull.x - center.x) * t,
                 y: center.y + (entryFull.y - center.y) * t });
      // Arc with scaled radius — smooth collapse to center as t→0.
      const a0 = Math.atan2(entryFull.y - center.y, entryFull.x - center.x);
      const a1 = Math.atan2(exitFull.y  - center.y, exitFull.x  - center.x);
      const evx = entryFull.x - center.x, evy = entryFull.y - center.y;
      const xvx = exitFull.x  - center.x, xvy = exitFull.y  - center.y;
      const cross2 = evx * xvy - evy * xvx;
      let dAngle = a1 - a0;
      if (cross2 > 0) { if (dAngle <= 0) dAngle += 2 * Math.PI; }
      else if (cross2 < 0) { if (dAngle >= 0) dAngle -= 2 * Math.PI; }
      if (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
      if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
      const Rt = R * t;
      if (Rt > 0.5 && Math.abs(dAngle) > 0.01) {
        const steps = Math.max(2, Math.ceil(Math.abs(dAngle) / (Math.PI / 6)));
        for (let s = 1; s <= steps; s++) {
          const a = a0 + dAngle * (s / steps);
          out.push({ x: center.x + Math.cos(a) * Rt, y: center.y + Math.sin(a) * Rt });
        }
      } else {
        out.push({ x: center.x + (exitFull.x - center.x) * t,
                   y: center.y + (exitFull.y - center.y) * t });
      }
      continue;
    }

    const entry = tangentPt(center, d_in,  ld);
    const exit  = tangentPt(center, d_out, ld);

    // Straight segment ends at entry tangent.
    out.push(entry);

    // Check whether the two perpendicular vectors are identical (straight path)
    // or anti-parallel (U-turn, 180° arc).
    const evx = entry.x - center.x, evy = entry.y - center.y;
    const xvx = exit.x  - center.x, xvy = exit.y  - center.y;

    const cross = evx * xvy - evy * xvx;

    if (Math.hypot(entry.x - exit.x, entry.y - exit.y) < 0.5) {
      // Straight — entry and exit tangents coincide, no arc needed.
      continue;
    }

    const a0 = Math.atan2(evy, evx);
    const a1 = Math.atan2(xvy, xvx);
    let dAngle = a1 - a0;

    if (cross > 0) {
      if (dAngle <= 0) dAngle += 2 * Math.PI;
    } else if (cross < 0) {
      if (dAngle >= 0) dAngle -= 2 * Math.PI;
    } else {
      if (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
      if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
    }

    // Clamp to short arc (|dAngle| ≤ π) for non-antiparallel cases.
    if (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
    if (dAngle < -Math.PI) dAngle += 2 * Math.PI;

    out.push(...arcPoints(center, a0, dAngle));
  }

  // ── Last point (boat / anchor): centered, no offset ──
  out.push({ x: rawPoints[N - 1].x, y: rawPoints[N - 1].y });

  return out;
}

function _redrawChain(px, py) {
  if (!chainSvgEl || !gridEl || !_chainState) return;
  const { gears, gearsLeft, level } = _chainState;
  chainSvgEl.innerHTML = '';

  const gridRect = gridEl.getBoundingClientRect();
  const W = gridRect.width;
  const H = gridRect.height;
  chainSvgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // Scale all gear/chain dimensions relative to the current cell size.
  // 50px is the reference cell size at which the hardcoded values were tuned.
  const cellSize = W / level.width;
  const scale    = cellSize / 68;

  // Build the list of points: start cell → each gear → current player pixel
  const rawPoints = [
    _cellPixel(level.start.x, level.start.y, level),
    ...gears.map(g => _cellPixel(g.x, g.y, level)),
    { x: px, y: py },
  ];

  if (rawPoints.length < 2) return;

  // Build a realistic chain path where the chain enters and exits each gear
  // tangentially and wraps around the gear arc between those points.
  // The chain always runs on the 90° CCW side of its travel direction
  // (down→left, up→right, right→down, left→up).
  // The chain wrap radius matches the gear's inner sprocket circle.
  const COG_R = 15 * scale; // matches gearInnerR — chain rides on inner teeth
  // Lerp factor for the gear nearest the player (index 1 in reversed path).
  // Derived from spatial distance: 0 when player is on the gear (centered),
  // 1 when player is ≥1 cell away (full tangent offset).
  // Works automatically for both forward moves (player moves away) and
  // backtrack (player approaches) with no flags or timing needed.
  let gearLerpT = 0;
  if (rawPoints.length >= 2) {
    const lastGear = rawPoints[rawPoints.length - 2]; // gear nearest player in original order
    const dist = Math.hypot(px - lastGear.x, py - lastGear.y);
    gearLerpT = Math.min(1, dist / cellSize);
  }
  const chainPoints = _buildChainPath([...rawPoints].reverse(), COG_R, gearLerpT);

  const NS = 'http://www.w3.org/2000/svg';

  // Linked chain along the offset path
  _drawChainLinks(chainPoints, NS, scale);

  // Gear shapes at each waypoint (skip start and player positions) — at raw cell centres
  const gearOuterR = 22.5 * scale;
  const gearInnerR = 15   * scale;
  const gearHoleR  = 6.25 * scale;
  const _spinProgress = _spinAngleBase + (_chainSpinning
    ? ((performance.now() - _spinStartTime) / spinPeriodMs()) * 360 * _spinDirection
    : 0);
  // Seed prevLocalDir from the first chain segment so straight-through gears
  // at the start of the path get the correct direction without a prior turn.
  const _seed_dx = rawPoints.length > 1 ? rawPoints[1].x - rawPoints[0].x : 1;
  const _seed_dy = rawPoints.length > 1 ? rawPoints[1].y - rawPoints[0].y : 0;
  let prevLocalDir = Math.sign(Math.abs(_seed_dx) - _seed_dy);
  for (let i = 1; i < rawPoints.length - 1; i++) {
    // Compute local chain direction using both incoming and outgoing segments.
    // The cross product of (d_in × d_out) matches the arc-sweep direction from
    // _buildChainPath: positive → CW on screen, negative → CCW on screen.
    // For straight-through (cross≈0), inherit the previous gear's direction.
    const ddx_in  = rawPoints[i].x - rawPoints[i - 1].x;
    const ddy_in  = rawPoints[i].y - rawPoints[i - 1].y;
    const ddx_out = rawPoints[i + 1].x - rawPoints[i].x;
    const ddy_out = rawPoints[i + 1].y - rawPoints[i].y;
    const cross   = ddx_in * ddy_out - ddy_in * ddx_out;
    const dot_io  = ddx_in * ddx_out + ddy_in * ddy_out;
    const localDir  = cross !== 0 ? Math.sign(cross) : prevLocalDir;
    prevLocalDir    = localDir;
    // Skip cog for straight-through positions (same direction, no bend or reversal).
    if (Math.abs(cross) < 0.01 && dot_io > 0) continue;
    const spinAngle = _spinProgress * localDir;
    const gGroup = document.createElementNS(NS, 'g');
    gGroup.setAttribute('class', 'gear-group');
    gGroup.setAttribute('transform', `translate(${rawPoints[i].x},${rawPoints[i].y}) rotate(${spinAngle})`);

    const g = document.createElementNS(NS, 'path');
    g.setAttribute('d', _gearPath(0, 0, gearOuterR, gearInnerR, 8));
    g.setAttribute('fill', 'rgb(50,70,110)');
    g.setAttribute('stroke', 'rgba(255,255,255,0.4)');
    g.setAttribute('stroke-width', String(0.8 * scale));
    gGroup.appendChild(g);

    const hole = document.createElementNS(NS, 'circle');
    hole.setAttribute('cx', '0');
    hole.setAttribute('cy', '0');
    hole.setAttribute('r', String(gearHoleR));
    hole.setAttribute('fill', 'rgba(255,255,255,0.5)');
    gGroup.appendChild(hole);

    chainSvgEl.appendChild(gGroup);
  }

  // Gear at the player position — spins the same as the last placed gear.
  if (rawPoints.length >= 2) {
    const px = rawPoints[rawPoints.length - 1].x;
    const py = rawPoints[rawPoints.length - 1].y;
    const spinAngle = _spinProgress * prevLocalDir;
    const gGroup = document.createElementNS(NS, 'g');
    gGroup.setAttribute('class', 'gear-group');
    gGroup.setAttribute('transform', `translate(${px},${py}) rotate(${spinAngle})`);
    const g = document.createElementNS(NS, 'path');
    g.setAttribute('d', _gearPath(0, 0, gearOuterR, gearInnerR, 8));
    g.setAttribute('fill', 'rgb(50,70,110)');
    g.setAttribute('stroke', 'rgba(255,255,255,0.4)');
    g.setAttribute('stroke-width', String(0.8 * scale));
    gGroup.appendChild(g);
    const hole = document.createElementNS(NS, 'circle');
    hole.setAttribute('cx', '0');
    hole.setAttribute('cy', '0');
    hole.setAttribute('r', String(gearHoleR));
    hole.setAttribute('fill', 'rgba(255,255,255,0.5)');
    gGroup.appendChild(hole);
    chainSvgEl.appendChild(gGroup);
  }

  // Update the counter span inside the player div
  if (counterSpan) counterSpan.textContent = gearsLeft;
}

/**
 * Draw animated chain links along the polyline defined by `points`.
 * Each link is a small oval; adjacent links alternate 90° (one along the path,
 * the next perpendicular) to mimic the look of a real linked chain.
 * When _chainSpinning is true the links scroll at CHAIN_LINK_SPEED px/ms.
 */
function _drawChainLinks(points, NS, scale = 1) {
  if (points.length < 2) return;

  const orx  = CHAIN_LINK_OUTER_RX * scale;
  const ory  = CHAIN_LINK_OUTER_RY * scale;
  const irx  = CHAIN_LINK_INNER_RX * scale;
  const iry  = CHAIN_LINK_INNER_RY * scale;
  const pitch = CHAIN_LINK_PITCH   * scale;
  const thinRy = 3.2 * scale;
  const segs = [];
  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i-1].x;
    const dy = points[i].y - points[i-1].y;
    const len = Math.hypot(dx, dy);
    if (len > 0.01) {
      segs.push({ x0: points[i-1].x, y0: points[i-1].y, dx, dy, len, cumLen: totalLen });
      totalLen += len;
    }
  }
  if (totalLen < 1 || segs.length === 0) return;

  // Sample a point + tangent angle at distance d along the path
  function sample(d) {
    d = Math.max(0, Math.min(d, totalLen));
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (d <= s.cumLen + s.len + 0.001 || i === segs.length - 1) {
        const t = s.len > 0 ? (d - s.cumLen) / s.len : 0;
        return {
          x:        s.x0 + s.dx * t,
          y:        s.y0 + s.dy * t,
          angleDeg: Math.atan2(s.dy, s.dx) * 180 / Math.PI,
        };
      }
    }
  }

  // Anchor chain links to player (point 0). Path is player→boat so d=0 is always
  // the player center — no scroll offset needed.
  const offset  = 0;
  const baseIdx = 0;

  // Face-on link: hollow oval ring with inner hole (fill-rule evenodd)
  const ringPath =
    `M ${orx},0 A ${orx},${ory},0,1,0,${-orx},0 A ${orx},${ory},0,1,0,${orx},0 Z ` +
    `M ${irx},0 A ${irx},${iry},0,1,1,${-irx},0 A ${irx},${iry},0,1,1,${irx},0 Z`;

  const linkTransforms = [];
  let linkIdx = 0;
  for (let d = offset; d <= totalLen; d += pitch) {
    const pt = sample(d);
    if (!pt) break;
    // Both link types keep long axis along the chain — no extraAngle rotation
    const parity = ((baseIdx + linkIdx) % 2 + 2) % 2;
    linkTransforms.push({ transform: `translate(${pt.x},${pt.y}) rotate(${pt.angleDeg})`, parity });
    linkIdx++;
  }

  function makeLinkEl(transform, isFaceOn) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', transform);
    if (isFaceOn) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', ringPath);
      path.setAttribute('fill', 'rgba(65,85,130,0.95)');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('stroke', 'rgba(190,215,245,0.85)');
      path.setAttribute('stroke-width', String(0.6 * scale));
      g.appendChild(path);
    } else {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', -orx);
      rect.setAttribute('y', -thinRy);
      rect.setAttribute('width', orx * 2);
      rect.setAttribute('height', thinRy * 2);
      rect.setAttribute('rx', thinRy);
      rect.setAttribute('ry', thinRy);
      rect.setAttribute('fill', 'rgba(50,68,110,0.9)');
      rect.setAttribute('stroke', 'rgba(150,185,230,0.7)');
      rect.setAttribute('stroke-width', String(0.5 * scale));
      g.appendChild(rect);
    }
    return g;
  }

  // Face-on (ring) links behind, edge-on (sliver) links in front
  for (const { transform, parity } of linkTransforms) {
    if (parity === 0) chainSvgEl.appendChild(makeLinkEl(transform, true));
  }
  for (const { transform, parity } of linkTransforms) {
    if (parity === 1) chainSvgEl.appendChild(makeLinkEl(transform, false));
  }
}

/**
 * Returns an SVG path string for a gear shape centred at (cx, cy).
 * @param {number} cx
 * @param {number} cy
 * @param {number} outerR  - tip of teeth radius
 * @param {number} innerR  - valley between teeth radius
 * @param {number} teeth   - number of teeth
 */
function _gearPath(cx, cy, outerR, innerR, teeth = 8) {
  const toothFrac = 0.35; // fraction of tooth arc occupied by the flat top
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = (2 * Math.PI * i)       / teeth - Math.PI / 2;
    const a1 = (2 * Math.PI * (i + 1)) / teeth - Math.PI / 2;
    const mid = (a0 + a1) / 2;
    const half = (a1 - a0) * toothFrac / 2;
    // valley → tooth rise → tooth top → tooth fall
    pts.push(`${cx + Math.cos(a0) * innerR},${cy + Math.sin(a0) * innerR}`);
    pts.push(`${cx + Math.cos(mid - half) * outerR},${cy + Math.sin(mid - half) * outerR}`);
    pts.push(`${cx + Math.cos(mid + half) * outerR},${cy + Math.sin(mid + half) * outerR}`);
    pts.push(`${cx + Math.cos(a1) * innerR},${cy + Math.sin(a1) * innerR}`);
  }
  return 'M ' + pts.join(' L ') + ' Z';
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Position and draw the boat SVG above the start cell,
 * and the waterline SVG at the top edge of the grid.
 */
function _updateBoatAndWaterline(level) {
  if (!boatEl || !waterlineEl || !gridEl || !containerEl) return;
  const gridRect      = gridEl.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();

  const gLeft = gridRect.left - containerRect.left;
  const gTop  = gridRect.top  - containerRect.top;
  const gW    = gridRect.width;
  const cellW = gridRect.width  / level.width;
  const cellH = gridRect.height / level.height;

  // ── Waterline ────────────────────────────────────────────────────────
  // Wave band height + extends 2.5 cells into the grid for water effect
  const wlH    = Math.max(8, cellH * 0.18);
  const waterH = wlH + cellH * 2.5;
  waterlineEl.style.left   = gLeft + 'px';
  waterlineEl.style.top    = (gTop - wlH * 0.5 + cellH * 0.5) + 'px';
  waterlineEl.style.width  = gW    + 'px';
  waterlineEl.style.height = waterH + 'px';
  _drawWaterline(gW, wlH, waterH);

  // ── Boat ─────────────────────────────────────────────────────────────
  // Hull deck line is at y≈34 out of viewBox height 60
  // Align that line with the waterline (gTop)
  const boatW   = cellW * 5.7;
  const boatH   = cellH * 3.0;
  const startCx = gLeft + (level.start.x + 0.5) * cellW;
  boatEl.style.left   = (startCx - boatW / 2) + 'px';
  boatEl.style.top    = (gTop - boatH * (34 / 60)) + 'px';
  boatEl.style.width  = boatW + 'px';
  boatEl.style.height = boatH + 'px';

  // ── Sky gradient ──────────────────────────────────────────────────────
  if (skyEl) {
    const skyH = Math.max(0, gTop - wlH * 0.5);
    skyEl.style.left    = gLeft + 'px';
    skyEl.style.top     = '0px';
    skyEl.style.width   = gW    + 'px';
    skyEl.style.height  = skyH  + 'px';
    skyEl.style.background = 'linear-gradient(to bottom, #3a7abd 0%, #6aaee0 45%, #a8d4f0 80%, rgba(168,212,240,0.3) 100%)';
  }
}

function _drawBoat() {
  if (!boatEl) return;
  fetch('./assets/boat.svg')
    .then(r => r.text())
    .then(svg => {
      const inner = svg.replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '');
      boatEl.innerHTML = inner;
    });
}

function _drawWaterline(W, wlH, totalH) {
  if (!waterlineEl) return;
  const NS = 'http://www.w3.org/2000/svg';
  waterlineEl.innerHTML = '';
  waterlineEl.setAttribute('viewBox', `0 0 ${W} ${totalH}`);

  const amp    = wlH * 0.38;
  const cy     = wlH * 0.55;
  const period = Math.max(30, W / 5);
  const cp     = period / 4;

  // Wave scrolls LEFT (natural ocean motion).
  // At t=0 visible area is x=[0,W]; at t=1 (translate=-period) visible is x=[period, W+period].
  // So wave path must cover x=[0, W + period*2] to always fill the visible window.
  const coverW   = W + period * 2;
  const nPeriods = Math.ceil(coverW / period) + 1;

  let waveLine = `M 0 ${cy}`;
  for (let i = 0; i < nPeriods; i++) {
    const x0 = i * period;
    waveLine += ` C ${x0 + cp} ${cy - amp}, ${x0 + period - cp} ${cy + amp}, ${x0 + period} ${cy}`;
  }
  const waveRight = nPeriods * period;
  const waveFill  = waveLine + ` L ${waveRight} ${totalH} L 0 ${totalH} Z`;

  const g = document.createElementNS(NS, 'g');

  // Gradient fill: solid water colour at the wave, fades to transparent lower
  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', 'wlFade');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const s0 = document.createElementNS(NS, 'stop');
  s0.setAttribute('offset', '0%');    s0.setAttribute('stop-color', 'rgba(70,145,210,0.45)');
  const s1 = document.createElementNS(NS, 'stop');
  s1.setAttribute('offset', '55%');   s1.setAttribute('stop-color', 'rgba(50,120,185,0.20)');
  const s2 = document.createElementNS(NS, 'stop');
  s2.setAttribute('offset', '100%');  s2.setAttribute('stop-color', 'rgba(50,120,185,0)');
  grad.appendChild(s0); grad.appendChild(s1); grad.appendChild(s2);
  defs.appendChild(grad);
  waterlineEl.appendChild(defs);

  const fill = document.createElementNS(NS, 'path');
  fill.setAttribute('d', waveFill);
  fill.setAttribute('fill', 'url(#wlFade)');
  g.appendChild(fill);

  const stroke = document.createElementNS(NS, 'path');
  stroke.setAttribute('d', waveLine);
  stroke.setAttribute('fill', 'none');
  stroke.setAttribute('stroke', 'rgba(70,140,200,0.80)');
  stroke.setAttribute('stroke-width', '1.5');
  stroke.setAttribute('stroke-linecap', 'round');
  g.appendChild(stroke);

  // Scroll left by one period — seamless because wave covers extra width to the right
  const anim = document.createElementNS(NS, 'animateTransform');
  anim.setAttribute('attributeName', 'transform');
  anim.setAttribute('type', 'translate');
  anim.setAttribute('from', '0 0');
  anim.setAttribute('to', `-${period} 0`);
  anim.setAttribute('dur', '2.5s');
  anim.setAttribute('repeatCount', 'indefinite');
  g.appendChild(anim);

  waterlineEl.appendChild(g);
}

function _cellPixel(x, y, level) {
  // Read the actual rendered position of the cell element rather than
  // approximating with rect.width/cols — this correctly handles the grid
  // border, gap, and any fractional pixel sizing automatically.
  // y = -1 means one cell above the top row (boat entry point above the grid).
  const refY = y < 0 ? 0 : y;
  const cellEl = gridEl.children[refY * level.width + x];
  const cellRect = cellEl.getBoundingClientRect();
  const gridRect = gridEl.getBoundingClientRect();
  // clientLeft/clientTop = border width; overlays are positioned from the
  // padding edge (inside the border), so we subtract it from the offset.
  return {
    x: cellRect.left - gridRect.left - gridEl.clientLeft + cellRect.width  / 2,
    y: cellRect.top  - gridRect.top  - gridEl.clientTop  + cellRect.height / 2 - (y < 0 ? cellRect.height : 0),
  };
}

function _placeOverlay(el, x, y, level) {
  const px = _cellPixel(x, y, level);
  _setOverlayPixel(el, px.x, px.y);
}

function _setOverlayPixel(el, cx, cy) {
  if (el === playerEl) playerPx = { x: cx, y: cy };
  el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
}
