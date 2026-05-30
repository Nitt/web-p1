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

export function toggleWaveDebug() {
  _waveDebugOn = !_waveDebugOn;
  if (!_waveDebugOn && _waveDebugDots) {
    _waveDebugDots.forEach(d => d.remove());
    _waveDebugDots = null;
  }
}

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
let _waveAnimHandle = null;
let _waveFnSmall    = null;   // (xn, t) → dy in SVG units; set in _loadAndAnimateWaterline
let _waveFnBig      = null;   // (xn, t) → dy in SVG units; set in _loadAndAnimateWaterline
let _waveLayout     = null;   // boat/waterline layout dims; set in _updateBoatAndWaterline
let _waveChainOffset = { dx: 0, dy: 0 }; // chain start offset driven by wave each frame
let _waveDebugOn   = false;
let _waveDebugDots = null; // three DOM elements when debug is active
let containerEl = null;
let diveIndicatorEl = null;
let moveHintEl = null;
let _currentLevel = null;
let _gearHeartsEl = null;
// Tracks the last pixel position written to the player overlay.
// Used as the authoritative animation start so there is never a
// discrepancy between the visual position and the animation origin.
let playerPx = { x: 0, y: 0 };
// Stores the last drawChain arguments so the animation loop can redraw each frame.
let _chainState = null;
// Gear spin state — driven by JS so rotation is continuous despite per-frame DOM recreation.
let _chainSpinning   = false;
let _tailGearSpins   = true;
let _playerAnimToken = 0;
// True while the player is mid-teleport flash (invisible between entry and exit).
// Suppresses the post-bridge chain segment so there is no ghost chain during the flash.
let _playerInTeleport = false;
// During a retrace flash (second half), holds grid coords of a visual-only bridge that
// keeps the teleporter visually connected until the player finishes fading in at the exit.
let _flashRetraceBridge = null;
let _jerkAnchorPx = null;  // extra chain point held fixed during jerk, cleared when jerk ends
let _jerkAvatarOnly = false; // when true, jerk moves the sprite only and leaves chain drawing to the retract anim
export function setJerkAvatarOnly(v) { _jerkAvatarOnly = v; }
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

// ── Chain color stops ─────────────────────────────────────────────────────────
// upTo: cells remaining until the chain is fully extended (measured from the far end
//       of the maximum chain length). upTo:3 means "the last 3 cells before full
//       extension" — those links only become visible as the chain nears its limit.
// color: a single '#rrggbb' / 'rgb(...)' / 'rgba(...)' — shading is derived automatically.
//        Or [colorA, colorB] to smoothly gradient from colorA to colorB across this stop.
// The last entry should use upTo: Infinity to cover the rest of the chain.
const CHAIN_COLOR_STOPS = [
  { upTo: 2,        color: '#c4a493' },
  { upTo: 6,        color: '#baa73f' },
  { upTo: 12,        color: '#547b40' },
  { upTo: Infinity, color: '#415582' },
];

function _parseColor(c) {
  if (typeof c !== 'string') return { r: 65, g: 85, b: 130 };
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
  }
  const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : { r: 65, g: 85, b: 130 };
}

function _lerpRgb(a, b, t) {
  return { r: Math.round(a.r+(b.r-a.r)*t), g: Math.round(a.g+(b.g-a.g)*t), b: Math.round(a.b+(b.b-a.b)*t) };
}

function _chainColors(rgb) {
  const W   = { r:255, g:255, b:255 };
  const drk = _lerpRgb(rgb, { r:0, g:0, b:0 }, 0.2);
  const hi  = _lerpRgb(rgb, W, 0.55);
  const mid = _lerpRgb(rgb, W, 0.40);
  return {
    faceOn:     `rgba(${rgb.r},${rgb.g},${rgb.b},0.95)`,
    faceStroke: `rgba(${hi.r},${hi.g},${hi.b},0.85)`,
    edgeOn:     `rgba(${drk.r},${drk.g},${drk.b},0.9)`,
    edgeStroke: `rgba(${mid.r},${mid.g},${mid.b},0.7)`,
  };
}


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
  _gearHeartsEl = document.getElementById('gear-hearts');

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
      if (type === CellType.WALL)       cell.dataset.type = 'wall';
      if (type === CellType.STICKY)     cell.dataset.type = 'sticky';
      if (type === CellType.CRUMBLE)    cell.dataset.type = 'crumble';
      if (type === CellType.KEY)        cell.dataset.type = 'key';
      if (type === CellType.DOOR)       cell.dataset.type = 'door';
      if (type === CellType.TELEPORTER) cell.dataset.type = 'teleporter';
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
  _loadAndAnimateWaterline();

  boatEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  boatEl.setAttribute('class', 'boat-svg');
  boatEl.setAttribute('viewBox', '0 0 100 60');
  _drawBoat();
  container.appendChild(boatEl);

  // Clear any leftover dive indicator from the previous level.
  if (diveIndicatorEl) { diveIndicatorEl.remove(); diveIndicatorEl = null; }

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
 *
 * @param {{x,y}} from
 * @param {{x,y}} to
 * @param {object} level
 * @param {()=>void} onDone
 * @param {{entryPos:{x,y}, exitPos:{x,y}, onTeleportCrossing:()=>void}|null} teleportInfo
 *   When non-null, the move crosses a teleporter.  The animation plays in three phases:
 *   slide to entry → flash out/in (calling onTeleportCrossing at the midpoint) → slide to to.
 */
export function animatePlayer(from, to, level, onDone, teleportInfo = null, jerkDir = null) {
  if (!teleportInfo) {
    _animateSlide(from, to, level, true, onDone, jerkDir);
    return;
  }

  // ── Two-phase teleport animation ─────────────────────────────────────────
  const { entryPos, exitPos, onTeleportCrossing } = teleportInfo;
  const token = ++_playerAnimToken;
  _tailGearSpins = false;

  // Phase 1 — slide from → entryPos
  _placeOverlay(playerEl, from.x, from.y, level);
  const startPx1 = { ...playerPx };
  const steps1   = Math.max(Math.abs(entryPos.x - from.x), Math.abs(entryPos.y - from.y));
  const dur1     = steps1 * speedMs();
  const t1Start  = performance.now();

  function phase1(now) {
    if (token !== _playerAnimToken) { _tailGearSpins = true; return; }
    const t = steps1 > 0 ? Math.min((now - t1Start) / dur1, 1) : 1;
    const entryPx = _cellPixel(entryPos.x, entryPos.y, level);
    const cx = startPx1.x + (entryPx.x - startPx1.x) * t;
    const cy = startPx1.y + (entryPx.y - startPx1.y) * t;
    _setOverlayPixel(playerEl, cx, cy);
    if (_chainState) _redrawChain(cx, cy);
    if (t < 1) { requestAnimationFrame(phase1); } else { beginFlash(); }
  }

  // Flash — fade out at entry, jump to exit pixel at midpoint, fade in
  // onTeleportCrossing is called at the midpoint so game.js pushes to state.gears
  // exactly when the player becomes invisible.
  const FLASH_MS = 180;
  let _flashJumped      = false;
  let _flashWasSpinning = false;  // whether _chainSpinning was true when flash started

  function beginFlash() {
    if (token !== _playerAnimToken) { _tailGearSpins = true; return; }
    _flashJumped        = false;
    _flashRetraceBridge = null;
    // Freeze gear rotation for the duration of the flash — chain is not moving
    // while the player is invisible, so spinning gears look wrong.
    _flashWasSpinning = _chainSpinning;
    if (_chainSpinning) {
      _spinAngleBase += ((performance.now() - _spinStartTime) / spinPeriodMs()) * 360 * _spinDirection;
      _chainSpinning  = false;
    }
    const flashStart  = performance.now();
    const entryPx     = _cellPixel(entryPos.x, entryPos.y, level);
    const exitPx      = _cellPixel(exitPos.x,  exitPos.y,  level);

    function flashFrame(now) {
      if (token !== _playerAnimToken) { _playerInTeleport = false; _tailGearSpins = true; return; }
      const ft = Math.min((now - flashStart) / (FLASH_MS * _speedMult), 1);

      if (ft < 0.5) {
        // Fade out — player at entry pixel
        playerEl.style.opacity = String(1 - ft * 2);
        _setOverlayPixel(playerEl, entryPx.x, entryPx.y);
        if (_chainState) _redrawChain(entryPx.x, entryPx.y);
      } else {
        // At midpoint: push the crossing to state.gears, jump player to exit
        if (!_flashJumped) {
          _flashJumped = true;
          const wasRetrace = onTeleportCrossing();
          _playerInTeleport = false;
          if (wasRetrace) {
            // Keep a visual bridge from entry→exit while the player fades in at exit.
            // Without this the crossing gear disappears from state.gears immediately,
            // making the chain snap to a straight line before the flash finishes.
            _flashRetraceBridge = { fromX: entryPos.x, fromY: entryPos.y,
                                    toX: exitPos.x,  toY: exitPos.y };
          }
        }
        playerEl.style.opacity = String((ft - 0.5) * 2);
        _setOverlayPixel(playerEl, exitPx.x, exitPx.y);
        if (_chainState) _redrawChain(exitPx.x, exitPx.y);
      }

      if (ft < 1) {
        requestAnimationFrame(flashFrame);
      } else {
        playerEl.style.opacity = '1';
        beginPhase3();
      }
    }
    requestAnimationFrame(flashFrame);
  }

  // Phase 3 — slide exitPos → to
  function beginPhase3() {
    if (token !== _playerAnimToken) { _tailGearSpins = true; return; }
    _flashRetraceBridge = null;
    if (_flashWasSpinning) {
      _spinStartTime = performance.now();
      _chainSpinning = true;
    }
    const startPx3 = { ...playerPx }; // currently at exitPx
    const steps3   = Math.max(Math.abs(to.x - exitPos.x), Math.abs(to.y - exitPos.y));
    const dur3     = steps3 * speedMs();
    const t3Start  = performance.now();

    if (steps3 === 0) { _tailGearSpins = true; onDone(); return; }

    function phase3(now) {
      if (token !== _playerAnimToken) { _tailGearSpins = true; return; }
      const t    = Math.min((now - t3Start) / dur3, 1);
      const endPx = _cellPixel(to.x, to.y, level);
      const cx   = startPx3.x + (endPx.x - startPx3.x) * t;
      const cy   = startPx3.y + (endPx.y - startPx3.y) * t;
      _setOverlayPixel(playerEl, cx, cy);
      if (_chainState) _redrawChain(cx, cy);
      if (t < 1) { requestAnimationFrame(phase3); } else { _tailGearSpins = true; onDone(); }
    }
    requestAnimationFrame(phase3);
  }

  requestAnimationFrame(phase1);
}

// Internal single-phase slide used by animatePlayer (non-teleport) and win/backtrack animations.
// jerkDir: optional {dx,dy} — if set, plays a chain-snap bounce at the end before calling onDone.
function _animateSlide(from, to, level, manageTailSpin, onDone, jerkDir = null) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (steps === 0) { onDone(); return; }

  const token    = ++_playerAnimToken;
  const duration = steps * speedMs();
  const startTime = performance.now();
  _placeOverlay(playerEl, from.x, from.y, level);
  const startPx = { ...playerPx };

  if (manageTailSpin) _tailGearSpins = false;
  function frame(now) {
    if (token !== _playerAnimToken) { if (manageTailSpin) _tailGearSpins = true; return; }
    const t   = Math.max(0, Math.min((now - startTime) / duration, 1));
    const endPx = _cellPixel(to.x, to.y, level);
    const cx  = startPx.x + (endPx.x - startPx.x) * t;
    const cy  = startPx.y + (endPx.y - startPx.y) * t;
    _setOverlayPixel(playerEl, cx, cy);
    if (_chainState) _redrawChain(cx, cy);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      if (manageTailSpin) _tailGearSpins = true;
      if (jerkDir) {
        // Capture token before onDone — onDone clears isMoving and may flush a queued
        // move, which bumps _playerAnimToken and automatically cancels the jerk.
        const jerkToken = _playerAnimToken;
        onDone();
        _animateChainJerk(_cellPixel(to.x, to.y, level), jerkDir, level, jerkToken);
      } else {
        onDone();
      }
    }
  }
  requestAnimationFrame(frame);
}

// Fire-and-forget bounce: player lurches forward then springs back, chain follows.
// token is passed explicitly so the caller controls when the jerk is cancelled.
// A new animatePlayer call bumps _playerAnimToken; the next frame sees the mismatch and exits.
function _animateChainJerk(endPx, { dx, dy }, level, token) {
  const JERK_MS  = 260 * _speedMult;
  const cellSize = gridEl.getBoundingClientRect().width / level.width;
  const A        = cellSize * 0.35;
  const startTime = performance.now();
  if (!_jerkAvatarOnly) _jerkAnchorPx = endPx;

  function frame(now) {
    if (token !== _playerAnimToken) { _jerkAnchorPx = null; return; }
    const t      = Math.min((now - startTime) / JERK_MS, 1);
    const offset = A * Math.exp(-5 * t) * Math.sin(Math.PI * 2 * 1.2 * t);
    _setOverlayPixel(playerEl, endPx.x + dx * offset, endPx.y + dy * offset);
    if (!_jerkAvatarOnly && _chainState) _redrawChain(endPx.x + dx * offset, endPx.y + dy * offset);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      _jerkAnchorPx = null;
      _setOverlayPixel(playerEl, endPx.x, endPx.y);
      if (!_jerkAvatarOnly && _chainState) _redrawChain(endPx.x, endPx.y);
    }
  }
  requestAnimationFrame(frame);
}

/** Fire-and-forget in-place jerk at `pos` in direction `dir`. No isMoving guard needed. */
export function animateChainJerkInPlace(pos, dir, level) {
  _animateChainJerk(_cellPixel(pos.x, pos.y, level), dir, level, _playerAnimToken);
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
  _chainState = { gears, playerPos, gearsLeft, totalGears, level };
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

export function setTailGearSpinning(spins) { _tailGearSpins = spins; }

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

function _appendGear(svgEl, cx, cy, outerR, innerR, holeR, spinAngle, scale, NS) {
  const gGroup = document.createElementNS(NS, 'g');
  gGroup.setAttribute('class', 'gear-group');
  gGroup.setAttribute('transform', `translate(${cx},${cy}) rotate(${spinAngle})`);
  const g = document.createElementNS(NS, 'path');
  g.setAttribute('d', _gearPath(0, 0, outerR, innerR, 8));
  g.setAttribute('fill', 'rgb(50,70,110)');
  g.setAttribute('stroke', 'rgba(255,255,255,0.4)');
  g.setAttribute('stroke-width', String(0.8 * scale));
  gGroup.appendChild(g);
  const hole = document.createElementNS(NS, 'circle');
  hole.setAttribute('cx', '0');
  hole.setAttribute('cy', '0');
  hole.setAttribute('r', String(holeR));
  hole.setAttribute('fill', 'rgba(255,255,255,0.5)');
  gGroup.appendChild(hole);
  svgEl.appendChild(gGroup);
}

function _redrawChain(px, py) {
  if (!chainSvgEl || !gridEl || !_chainState) return;
  const { gears, playerPos, gearsLeft, totalGears, level } = _chainState;
  chainSvgEl.innerHTML = '';

  const gridRect = gridEl.getBoundingClientRect();
  const W = gridRect.width;
  const H = gridRect.height;
  chainSvgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const cellSize = W / level.width;
  const scale    = cellSize / 68;
  const COG_R    = 15 * scale;
  const NS       = 'http://www.w3.org/2000/svg';

  // ── Build chain segments ───────────────────────────────────────────────────
  // Teleporter crossings split the chain into solid segments connected by bridges.
  // Each segment: array of pixel points.  Bridges: {from, to} pixel pairs.
  const startPxBase = _cellPixel(level.start.x, level.start.y, level);
  const startPx = {
    x: startPxBase.x + _waveChainOffset.dx,
    y: (_waveLayout ? _waveLayout.chainStartBaseY : startPxBase.y) + _waveChainOffset.dy,
  };
  const segments = [];
  const bridges  = [];     // { from:{x,y}, to:{x,y} } in pixels
  let   curSeg   = [startPx];

  for (const g of gears) {
    if (g.isTeleport) {
      curSeg.push(_cellPixel(g.x, g.y, level));
      segments.push(curSeg);
      const exitPx = _cellPixel(g.exitX, g.exitY, level);
      bridges.push({ from: curSeg[curSeg.length - 1], to: exitPx });
      curSeg = [exitPx];
    } else {
      curSeg.push(_cellPixel(g.x, g.y, level));
    }
  }

  // Append player pixel to the last segment — unless mid-flash (player invisible at entry).
  // During a jerk, insert the anchor (stop position) so only the short jerk segment moves.
  if (!_playerInTeleport) {
    if (_jerkAnchorPx) curSeg.push({ x: _jerkAnchorPx.x, y: _jerkAnchorPx.y });
    curSeg.push({ x: px, y: py });
  }
  segments.push(curSeg);

  // During a retrace flash, keep a visual bridge from entry→exit so the chain
  // doesn't snap to a straight line while the player is fading in at the exit.
  if (_flashRetraceBridge) {
    const fb = _flashRetraceBridge;
    bridges.push({
      from: _cellPixel(fb.fromX, fb.fromY, level),
      to:   _cellPixel(fb.toX,   fb.toY,   level),
    });
  }

  // ── gearLerpT for the last segment's nearest gear ─────────────────────────
  const lastSeg = segments[segments.length - 1];
  let gearLerpT = 1;
  if (!_playerInTeleport && lastSeg.length >= 2) {
    const nearestGearPx = lastSeg[lastSeg.length - 2];
    gearLerpT = Math.min(1, Math.hypot(px - nearestGearPx.x, py - nearestGearPx.y) / cellSize);
  }

  // ── Compute per-segment chain-length offsets from the player for link phase-locking ──
  // segOffsets[si] = chain length (pixels) from the player to d=0 of segment si,
  // accumulated only through physical segments — NOT through bridges, which carry
  // zero chain length.  Excluding bridge pixel distance is critical: if we included
  // it, a discontinuous jump in linkStartDist would occur the moment onTeleportCrossing
  // fires (the bridge length would suddenly appear in the offset), causing a visible
  // phase-shift in the link pattern.  Last segment offset = 0 (player is at d=0).
  const segOffsets = new Array(segments.length).fill(0);
  {
    let cum = 0;
    for (let si = segments.length - 1; si >= 0; si--) {
      segOffsets[si] = cum;
      const seg = segments[si];
      let segLen = 0;
      for (let i = 1; i < seg.length; i++) {
        segLen += Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
      }
      cum += segLen;
      // Bridges are zero-cost — do not add their pixel length.
    }
  }

  // ── Draw solid chain segments ──────────────────────────────────────────────
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.length < 2) continue;
    const lerpT      = si === segments.length - 1 ? gearLerpT : 1;
    const chainPoints = _buildChainPath([...seg].reverse(), COG_R, lerpT);
    _drawChainLinks(chainPoints, NS, scale, cellSize, segOffsets[si], si === segments.length);
  }

  // ── Draw teleporter bridges ────────────────────────────────────────────────
  for (const bridge of bridges) {
    _drawTeleporterBridge(bridge.from, bridge.to, NS, scale);
  }

  // ── Draw gear shapes ──────────────────────────────────────────────────────
  const gearOuterR    = 22.5 * scale;
  const gearInnerR    = 15   * scale;
  const gearHoleR     = 6.25 * scale;
  const _spinProgress = _spinAngleBase + (_chainSpinning
    ? ((performance.now() - _spinStartTime) / spinPeriodMs()) * 360 * _spinDirection
    : 0);

  // Compute prevLocalDir per segment so spin direction is consistent across
  // teleport gaps. Within each segment the logic is the same as before.
  let prevLocalDir = 1;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.length < 1) continue;
    // Seed direction from first two points of this segment.
    if (seg.length >= 2) {
      const sdx = seg[1].x - seg[0].x, sdy = seg[1].y - seg[0].y;
      if (si === 0) prevLocalDir = Math.sign(Math.abs(sdx) - sdy) || 1;
    }
    for (let i = 1; i < seg.length - 1; i++) {
      const ddx_in  = seg[i].x - seg[i - 1].x, ddy_in  = seg[i].y - seg[i - 1].y;
      const ddx_out = seg[i + 1].x - seg[i].x, ddy_out = seg[i + 1].y - seg[i].y;
      const cross   = ddx_in * ddy_out - ddy_in * ddx_out;
      const dot_io  = ddx_in * ddx_out + ddy_in * ddy_out;
      const localDir = cross !== 0 ? Math.sign(cross) : prevLocalDir;
      prevLocalDir   = localDir;
      if (Math.abs(cross) < 0.01 && dot_io > 0) continue; // straight-through — no cog
      // First point is the segment anchor (boat/teleport-exit), last is player/teleport-entry.
      // Don't draw a cog at anchor endpoints.
      _appendGear(chainSvgEl, seg[i].x, seg[i].y,
                  gearOuterR, gearInnerR, gearHoleR, _spinProgress * localDir, scale, NS);
    }
    // Draw teleporter portal circles at segment boundaries (entry and exit).
    if (si < bridges.length) {
      _drawTeleporterPortal(bridges[si].from.x, bridges[si].from.y, NS, scale);
      _drawTeleporterPortal(bridges[si].to.x,   bridges[si].to.y,   NS, scale);
    }
  }

  // Portals for the retrace-flash visual bridge (not associated with any segment).
  if (_flashRetraceBridge) {
    const fb = bridges[bridges.length - 1];
    _drawTeleporterPortal(fb.from.x, fb.from.y, NS, scale);
    _drawTeleporterPortal(fb.to.x,   fb.to.y,   NS, scale);
  }

  // Tail gear at player (skip while mid-flash).
  if (!_playerInTeleport && lastSeg.length >= 1) {
    const lastPt = lastSeg[lastSeg.length - 1];
    _appendGear(chainSvgEl, lastPt.x, lastPt.y,
                gearOuterR, gearInnerR, gearHoleR,
                _tailGearSpins ? _spinProgress * prevLocalDir : _spinAngleBase * prevLocalDir,
                scale, NS);
  }

  // ── Counter / hearts / chain bar ──────────────────────────────────────────
  if (counterSpan) counterSpan.textContent = gearsLeft;

  if (_gearHeartsEl && totalGears > 0) {
    _gearHeartsEl.innerHTML = '';
    for (let i = 0; i < totalGears; i++) {
      const h = document.createElement('div');
      h.className = i < gearsLeft ? 'gear-heart full' : 'gear-heart empty';
      _gearHeartsEl.appendChild(h);
    }
  }

}

/** Draw a dashed bridge line between two teleporter portal positions. */
function _drawTeleporterBridge(fromPx, toPx, NS, scale) {
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('x1', fromPx.x); line.setAttribute('y1', fromPx.y);
  line.setAttribute('x2', toPx.x);   line.setAttribute('y2', toPx.y);
  line.setAttribute('stroke', 'rgba(190, 100, 255, 0.65)');
  line.setAttribute('stroke-width', String(2.5 * scale));
  line.setAttribute('stroke-dasharray', `${7 * scale} ${5 * scale}`);
  line.setAttribute('stroke-linecap', 'round');
  chainSvgEl.appendChild(line);
}

/** Draw a glowing portal ring at a teleporter entry/exit position. */
function _drawTeleporterPortal(cx, cy, NS, scale) {
  const r = 11 * scale;
  const outer = document.createElementNS(NS, 'circle');
  outer.setAttribute('cx', cx); outer.setAttribute('cy', cy);
  outer.setAttribute('r', String(r));
  outer.setAttribute('fill', 'rgba(120, 50, 200, 0.25)');
  outer.setAttribute('stroke', 'rgba(210, 130, 255, 0.9)');
  outer.setAttribute('stroke-width', String(2 * scale));
  chainSvgEl.appendChild(outer);
}

/**
 * Draw animated chain links along the polyline defined by `points`.
 * Each link is a small oval; adjacent links alternate 90° (one along the path,
 * the next perpendicular) to mimic the look of a real linked chain.
 * When _chainSpinning is true the links scroll at CHAIN_LINK_SPEED px/ms.
 */
function _drawChainLinks(points, NS, scale = 1, cellSize = 1, linkStartDist = 0, isLastSeg = false) {
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

      if (d <= s.cumLen + s.len || i === segs.length - 1) {

        const t = s.len > 0 ? (d - s.cumLen) / s.len : 0;

        const x = s.x0 + s.dx * t;
        const y = s.y0 + s.dy * t;

        return {
          x,
          y,
          angleDeg: Math.atan2(s.dy, s.dx) * 180 / Math.PI
        };
      }
    }
  }

  function colorStopAt(d) {
    const cellDist = (d + linkStartDist) / cellSize;
    const BLEND = 1.0; // cells to cross-fade over at each stop boundary
    let prevRgb = null, prevUpTo = 0;
    for (const stop of CHAIN_COLOR_STOPS) {
      if (cellDist < stop.upTo) {
        let rgb;
        if (Array.isArray(stop.color)) {
          const t = stop.upTo === Infinity ? 0
            : Math.max(0, Math.min(1, (cellDist - prevUpTo) / (stop.upTo - prevUpTo)));
          const c0 = _parseColor(stop.color[0]);
          const c1 = stop.color[1] != null ? _parseColor(stop.color[1]) : c0;
          rgb = _lerpRgb(c0, c1, t);
        } else {
          rgb = _parseColor(stop.color);
        }
        // Blend smoothly from the previous stop's boundary color into this stop
        if (prevRgb !== null && cellDist - prevUpTo < BLEND) {
          rgb = _lerpRgb(prevRgb, rgb, (cellDist - prevUpTo) / BLEND);
        }
        return _chainColors(rgb);
      }
      // Record this stop's color at its far boundary for use as the blend source
      if (Array.isArray(stop.color)) {
        const c1 = stop.color[1] != null ? stop.color[1] : stop.color[0];
        prevRgb = _parseColor(c1);
      } else {
        prevRgb = _parseColor(stop.color);
      }
      prevUpTo = stop.upTo;
    }
    const last = CHAIN_COLOR_STOPS[CHAIN_COLOR_STOPS.length - 1];
    const c = Array.isArray(last.color) ? last.color[1] : last.color;
    return _chainColors(_parseColor(c));
  }

  // Phase-lock links to the player end of the full chain.  linkStartDist is the
  // pixel distance from the player to the start (d=0) of this segment, through
  // any intervening bridges.  Without it, earlier segments anchor to their own
  // start (e.g. a teleporter entry) and appear static while the player moves.
  const phaseShift = linkStartDist - Math.floor(linkStartDist / pitch) * pitch;
  const startD = pitch - phaseShift;
  // For the last segment (player end) clamp startD=pitch → 0 so the first link sits right at
  // the player.  For earlier segments (fixed, teleporter-entry side) do NOT clamp: keeping
  // startD=pitch avoids a full-pitch position jump on the first frame of movement after a
  // teleport crossing, when linkStartDist transitions from exactly 0 to a tiny positive value.
  const safeStartD = startD < 0 ? 0 : (isLastSeg && startD >= pitch) ? 0 : startD;
  const baseIdx = Math.floor(linkStartDist / pitch) % 2;

  // Face-on link: hollow oval ring with inner hole (fill-rule evenodd)
  const ringPath =
    `M ${orx},0 A ${orx},${ory},0,1,0,${-orx},0 A ${orx},${ory},0,1,0,${orx},0 Z ` +
    `M ${irx},0 A ${irx},${iry},0,1,1,${-irx},0 A ${irx},${iry},0,1,1,${irx},0 Z`;

  const linkTransforms = [];

  const count = Math.floor((totalLen - safeStartD) / pitch) + 1;

  for (let i = 0; i < count; i++) {
    const d = safeStartD + i * pitch;

    const pt = sample(d);
    if (!pt) break;

    const parity = ((baseIdx + i) % 2 + 2) % 2;

    linkTransforms.push({
      transform: `translate(${pt.x},${pt.y}) rotate(${pt.angleDeg})`,
      parity,
      d
    });
  }

  function makeLinkEl(transform, isFaceOn, stop) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', transform);
    if (isFaceOn) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', ringPath);
      path.setAttribute('fill', stop.faceOn);
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('stroke', stop.faceStroke);
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
      rect.setAttribute('fill', stop.edgeOn);
      rect.setAttribute('stroke', stop.edgeStroke);
      rect.setAttribute('stroke-width', String(0.5 * scale));
      g.appendChild(rect);
    }
    return g;
  }

  // Face-on (ring) links behind, edge-on (sliver) links in front
  for (const { transform, parity, d } of linkTransforms) {
    if (parity === 0) chainSvgEl.appendChild(makeLinkEl(transform, true, colorStopAt(d)));
  }
  for (const { transform, parity, d } of linkTransforms) {
    if (parity === 1) chainSvgEl.appendChild(makeLinkEl(transform, false, colorStopAt(d)));
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

  const boatW   = cellW * 5.7;
  const boatH   = cellH * 3.0;
  const startCx = gLeft + (level.start.x + 0.5) * cellW;

  // ── Waterline ────────────────────────────────────────────────────────
  // Spans the boat footprint plus a small margin; nothing renders outside that.
  const wlH      = Math.max(8, cellH * 0.18);
  const waterH   = wlH + cellH * 2.5;
  const wlMargin = cellW * 0.6;
  const wlW      = boatW + wlMargin * 2;
  waterlineEl.style.left   = (startCx - wlW / 2) + 'px';
  waterlineEl.style.top    = (gTop - wlH * 0.5 + cellH * 0.5) + 'px';
  waterlineEl.style.width  = wlW   + 'px';
  waterlineEl.style.height = waterH + 'px';

  // ── Boat ─────────────────────────────────────────────────────────────
  // Hull deck line is at y≈34 out of viewBox height 60
  // Align that line with the waterline (gTop)
  boatEl.style.left   = (startCx - boatW / 2) + 'px';
  boatEl.style.width  = boatW + 'px';
  boatEl.style.height = boatH + 'px';
  const s2px = waterH / 30;
  // Boat center y in chain-SVG (grid-client) coords.
  // boatTopBase = gTop - boatH*(20/60); boat center = boatTopBase + boatH/2.
  // Chain SVG origin is at gTop + gridEl.clientTop.
  const chainStartBaseY = boatH * (0.5 - 20 / 60) - gridEl.clientTop;
  _waveLayout = { wlW, waterH, boatW, boatH, s2px, chainStartBaseY,
    boatTopBase: gTop - boatH * (25 / 60),
    wlLeft: startCx - wlW / 2,
    wlTop:  gTop - wlH * 0.5 + cellH * 0.5 };

  // ── Sky gradient ──────────────────────────────────────────────────────
  if (skyEl) {
    const skyH = Math.max(0, gTop - wlH * 0.5);
    skyEl.style.left    = gLeft + 'px';
    skyEl.style.top     = '0px';
    skyEl.style.width   = gW    + 'px';
    skyEl.style.height  = skyH  + 'px';
    skyEl.style.background = 'linear-gradient(to bottom, #3a7abd 0%, #6aaee0 45%, #a8d4f0 80%, rgba(168,212,240,0.3) 100%)';
  }
  if (diveIndicatorEl) _updateDiveIndicator(level);
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

function _loadAndAnimateWaterline() {
  if (!waterlineEl) return;
  if (_waveAnimHandle) { cancelAnimationFrame(_waveAnimHandle); _waveAnimHandle = null; }

  const NS = 'http://www.w3.org/2000/svg';
  waterlineEl.innerHTML = '';
  if (_waveDebugDots) { _waveDebugDots.forEach(d => d.remove()); _waveDebugDots = null; }
  waterlineEl.setAttribute('viewBox', '0 0 100 30');
  waterlineEl.setAttribute('preserveAspectRatio', 'none');
  waterlineEl.setAttribute('overflow', 'visible');

  const defs = document.createElementNS(NS, 'defs');
  // Horizontal mask fades the ends.
  // gradientUnits + maskUnits both use userSpaceOnUse so the mask covers the
  // full viewBox rather than the default objectBoundingBox, which hugs the
  // tight path bounds and clips the stroke-width at the top and bottom.
  const maskGrad = document.createElementNS(NS, 'linearGradient');
  maskGrad.setAttribute('id', 'wl-mask-grad');
  maskGrad.setAttribute('gradientUnits', 'userSpaceOnUse');
  maskGrad.setAttribute('x1', '0');   maskGrad.setAttribute('y1', '0');
  maskGrad.setAttribute('x2', '100'); maskGrad.setAttribute('y2', '0');
  [['0%', '#000'], ['15%', '#fff'], ['85%', '#fff'], ['100%', '#000']].forEach(([off, color]) => {
    const s = document.createElementNS(NS, 'stop');
    s.setAttribute('offset', off); s.setAttribute('stop-color', color);
    maskGrad.appendChild(s);
  });
  const mask = document.createElementNS(NS, 'mask');
  mask.setAttribute('id', 'wl-mask');
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  mask.setAttribute('x', '0'); mask.setAttribute('y', '-10');
  mask.setAttribute('width', '100'); mask.setAttribute('height', '50');
  const maskRect = document.createElementNS(NS, 'rect');
  maskRect.setAttribute('x', '0');    maskRect.setAttribute('y', '-10');
  maskRect.setAttribute('width', '100'); maskRect.setAttribute('height', '50');
  maskRect.setAttribute('fill', 'url(#wl-mask-grad)');
  mask.appendChild(maskRect);
  defs.appendChild(maskGrad);
  defs.appendChild(mask);
  waterlineEl.appendChild(defs);

  const strokePath = document.createElementNS(NS, 'path');
  strokePath.setAttribute('fill', 'none');
  strokePath.setAttribute('stroke', 'rgba(70,140,200,0.80)');
  strokePath.setAttribute('stroke-width', '1.5');
  strokePath.setAttribute('stroke-linecap', 'round');
  strokePath.setAttribute('stroke-linejoin', 'round');
  strokePath.setAttribute('mask', 'url(#wl-mask)');
  waterlineEl.appendChild(strokePath);

  _waveFnBig = (xn, t) =>
    0.6 * Math.sin(xn * 5  - t * 1.5) +
    0.1 * Math.sin(xn * 18  - t * 3) +
    -4.0;

  _waveFnSmall = (xn, t) =>
    0.1 * Math.sin(xn * 12 + t * -7.5) +
    0.05 * Math.sin(xn * 30 + t * 7.5);

  const N = 60, vbW = 100, baseY = 6;
  const basePts = Array.from({ length: N }, (_, i) => ({ x: i * vbW / (N - 1), y: baseY }));
  const t0 = performance.now();
  const capturedEl = waterlineEl;

  function frame(now) {
    if (waterlineEl !== capturedEl) return;
    const t = (now - t0) * 0.001;

    const pts = basePts.map(({ x, y }) => ({ x, y: y + _waveFnBig(x / vbW, t) + _waveFnSmall(x / vbW, t) }));
    strokePath.setAttribute('d', 'M ' + pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L '));

    // Bob and tilt the boat by sampling the wave at left, centre, right of the hull
    if (boatEl && _waveLayout) {
      const { wlW, waterH, boatW, boatH, boatTopBase, s2px } = _waveLayout;
      const boatWaveSampleWidth = 140;
      const xnL  = (1 - boatWaveSampleWidth / wlW) / 2;
      const xnR  = (1 + boatWaveSampleWidth / wlW) / 2;
      const boatDelay = -0.3;
      const dyL  = _waveFnBig(xnL, t+boatDelay) * s2px;
      const dyC  = _waveFnBig(0.5,  t+boatDelay) * s2px;
      const dyR  = _waveFnBig(xnR,  t+boatDelay) * s2px;
      const sampleDistPx = (xnR - xnL) * wlW;
      const deg  = Math.atan2(dyR - dyL, sampleDistPx) * 180 / Math.PI;
      boatEl.style.top             = (boatTopBase + dyC * 0.8).toFixed(1) + 'px';
      boatEl.style.transform       = `rotate(${deg.toFixed(2)*0.8}deg)`;
      //boatEl.style.transformOrigin = '100% 100%';

      // Chain start tracks the boat center — same dy as the boat, no horizontal sway
      _waveChainOffset.dy = dyC;
      _waveChainOffset.dx = deg*0.85;

      // Redraw chain every wave frame so the start point visibly tracks the boat
      if (_chainState) _redrawChain(playerPx.x, playerPx.y);

      // Debug: show the three sample points as coloured dots
      if (_waveDebugOn && containerEl) {
        if (!_waveDebugDots) {
          const colors = ['#f44', '#4f4', '#44f'];
          _waveDebugDots = colors.map(c => {
            const el = document.createElement('div');
            el.style.cssText = `position:absolute;width:7px;height:7px;border-radius:50%;`
              + `pointer-events:none;z-index:200;transform:translate(-50%,-50%);background:${c}`;
            containerEl.appendChild(el);
            return el;
          });
        }
        const { wlLeft, wlTop } = _waveLayout;
        const s2px = waterH / 30;
        [[xnL, dyL], [0.5, dyC], [xnR, dyR]].forEach(([xn, dy], i) => {
          _waveDebugDots[i].style.left = (wlLeft + xn * wlW).toFixed(1) + 'px';
          _waveDebugDots[i].style.top  = (wlTop + (6 + _waveFn(xn, t)) * s2px).toFixed(1) + 'px';
        });
      }
    }

    _waveAnimHandle = requestAnimationFrame(frame);
  }

  _waveAnimHandle = requestAnimationFrame(frame);
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

let _goalFollowsPlayer = false;
export function setGoalFollowsPlayer(v) { _goalFollowsPlayer = v; }

// ─── dive indicator ────────────────────────────────────────────────────────────

export function showDiveIndicator(level) {
  if (diveIndicatorEl) { diveIndicatorEl.remove(); diveIndicatorEl = null; }
  if (!containerEl) return;

  diveIndicatorEl = document.createElement('div');
  diveIndicatorEl.className = 'dive-indicator';

  const arrow = document.createElement('div');
  arrow.className = 'dive-arrow';
  arrow.textContent = '▼';

  const hint = document.createElement('div');
  hint.className = 'dive-hint';
  hint.textContent = 'Drag down or press ↓ to dive';

  diveIndicatorEl.appendChild(arrow);
  diveIndicatorEl.appendChild(hint);
  containerEl.appendChild(diveIndicatorEl);

  requestAnimationFrame(() => _updateDiveIndicator(level));
}

export function hideDiveIndicator() {
  if (!diveIndicatorEl) return;
  diveIndicatorEl.classList.add('hiding');
  const el = diveIndicatorEl;
  diveIndicatorEl = null;
  setTimeout(() => el.remove(), 280);
}

export function showDiveHint() {
  if (!diveIndicatorEl) return;
  const hint = diveIndicatorEl.querySelector('.dive-hint');
  if (hint) hint.classList.add('visible');
}

function _updateDiveIndicator(level) {
  if (!diveIndicatorEl || !gridEl || !containerEl) return;
  const gridRect      = gridEl.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();
  const cellW = gridRect.width  / level.width;
  const cellH = gridRect.height / level.height;
  const gLeft = gridRect.left - containerRect.left;
  const gTop  = gridRect.top  - containerRect.top;
  // Center on the first grid cell in the entry column (row 0, directly below the boat).
  diveIndicatorEl.style.left     = (gLeft + (level.start.x + 0.5) * cellW) + 'px';
  diveIndicatorEl.style.top      = (gTop + cellH * 1.5) + 'px';
  diveIndicatorEl.style.fontSize = Math.round(cellW * 0.72) + 'px';
}

// ─── move hint (after-dive inactivity nudge) ───────────────────────────────────

export function showMoveHint() {
  if (moveHintEl || !containerEl || !gridEl) return;
  const gridRect      = gridEl.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();
  const cx = gridRect.left - containerRect.left + gridRect.width  * 0.5;
  const cy = gridRect.top  - containerRect.top  + gridRect.height * 0.68;
  moveHintEl = document.createElement('div');
  moveHintEl.className = 'move-hint';
  moveHintEl.textContent = 'Drag in any direction or press an arrow key to move';
  moveHintEl.style.left = cx + 'px';
  moveHintEl.style.top  = cy + 'px';
  containerEl.appendChild(moveHintEl);
  requestAnimationFrame(() => { if (moveHintEl) moveHintEl.classList.add('visible'); });
}

export function hideMoveHint() {
  if (!moveHintEl) return;
  moveHintEl.classList.add('hiding');
  const el = moveHintEl;
  moveHintEl = null;
  setTimeout(() => el.remove(), 320);
}

function _setOverlayPixel(el, cx, cy) {
  if (el === playerEl) {
    playerPx = { x: cx, y: cy };
    if (_goalFollowsPlayer && goalEl) {
      goalEl.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    }
  }
  el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
}
