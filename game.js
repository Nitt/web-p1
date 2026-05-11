import { slidePlayer, buildToggleMap, canReachGoal } from './puzzle.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays, drawChain, drawChainWithPixelTail, getCellPixel, setChainSpinning, removeCrumble, removeKey, openDoor, getSpeedMultiplier } from './renderer.js';
import { initInput } from './input.js';
import { pregenNext, takePendingLevel, getPendingRecipe, generateFallback } from './progression.js';
import { SAMPLE_LEVELS } from './levels.js';
import { getRecipe } from './levelConfig.js';
import { playSlide, playLand, playBlocked, playCrumble, playKeyCollect, playDoorOpen, playWin, playDeadEnd } from './sounds.js';

// ─── DOM refs (set in init) ───────────────────────────────────────────────────
let gridContainer    = null;
let dpadEl           = null;
let winBanner        = null;
let deadEndBanner    = null;
let levelLabel       = null;

// Timer that fires the dead-end popup 1 second after landing in a dead end.
let _deadEndTimer = null;

// How many ms before animation end an input is still considered "on time".
// Inputs queued earlier than this window will be discarded.
const QUEUE_WINDOW_MS = 300;

// ─── game state ───────────────────────────────────────────────────────────────
const state = {
  level:                null,
  playerPos:            null,
  isMoving:             false,
  won:                  false,
  queuedMove:           null,   // { dx, dy, queuedAt } — next move buffered during animation
  nextId:               2,      // id for the next generated level
  nextSeed:             300,    // seed for level 2 (level 1 uses 0–299 as a safe margin)
  // Gear chain system (replaces movesLeft).
  gears:                [],     // [{x,y}] cog positions (bends/reversals only)
  gearsLeft:            0,      // remaining gear budget
  totalGears:           0,      // starting budget (used for display/scoring)
  prevDir:              null,   // {dx, dy} of last completed move, for bend detection
  // Parallel-universe / world-state system.
  worldState:           0,
  toggleMap:            null,
  // Progression tracking.
  levelIndex:           1,      // 1-indexed number of the level currently being played
  levelsSinceKeyDoor:   0,      // levels elapsed since last key/door level appeared
  // One-way double-press backtrack.
  pendingOnewayBreak:   null,   // { dx, dy, owx, owy } — set after first blocked-by-oneway press
};

// ─── entry point ─────────────────────────────────────────────────────────────
export function init() {
  gridContainer  = document.getElementById('grid-container');
  dpadEl         = document.getElementById('dpad');
  winBanner      = document.getElementById('win-banner');
  deadEndBanner  = document.getElementById('dead-end-banner');
  levelLabel     = document.getElementById('level-label');

  document.getElementById('restart-btn')
    .addEventListener('click', () => loadLevel(state.level));

  // Backtick (`) skips to the next level — debug/testing shortcut.
  document.addEventListener('keydown', e => {
    if (e.key === '`') skipLevel();
  });

  initInput(gridContainer, dpadEl, handleMove);

  new ResizeObserver(() => {
    if (state.level && !state.isMoving) {
      repositionOverlays(state.playerPos, state.level);
      drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
    }
  }).observe(gridContainer);

  loadLevel(SAMPLE_LEVELS[0]);
}

// ─── level loading ────────────────────────────────────────────────────────────
function loadLevel(level) {
  // Cancel any in-flight player or retraction animations from the previous level.
  _moveToken++;
  _retractToken++;
  state.level       = level;
  state.playerPos   = { ...level.start };
  state.isMoving    = false;
  state.won         = false;
  state.queuedMove  = null;
  state.worldState  = 0;
  state.toggleMap   = buildToggleMap(level.cells);
  state.pendingOnewayBreak = null;
  state.prevDir     = null;

  // Gear budget: exactly the minimum solution depth (bend count) from the BFS.
  const goalDepth = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x]
    : 0;
  const budget = goalDepth > 0 ? goalDepth : 1;
  state.gears      = [];
  state.gearsLeft  = budget;
  state.totalGears = budget;

  if (levelLabel) levelLabel.textContent = `Level ${level.id}`;
  winBanner.hidden     = true;
  deadEndBanner.hidden = true;
  clearTimeout(_deadEndTimer);
  _deadEndTimer = null;

  buildGrid(gridContainer, level);
  placePlayer(state.playerPos, level);
  drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, level);

  // Kick off background generation of the next level immediately.
  const nextRecipe = getRecipe(state.nextId, state.levelsSinceKeyDoor);
  pregenNext(state.nextSeed, state.nextId, nextRecipe);

  // Auto-slide the diver down from the surface into the water.
  _executeMove(0, 1);
}

function _nextLevel() {
  const seed = state.nextSeed;
  const id   = state.nextId;
  state.nextSeed += getPendingRecipe()?.candidates ?? 300;
  state.nextId   += 1;

  // Update progression counters before loading so loadLevel's pre-gen is accurate.
  state.levelIndex += 1;
  const hadKeyDoor = state.level?.doorRequirements?.size > 0;
  state.levelsSinceKeyDoor = hadKeyDoor ? 0 : state.levelsSinceKeyDoor + 1;

  // Use the pre-generated level if ready; otherwise generate synchronously with
  // a reduced candidate count to avoid blocking the main thread too long.
  Promise.resolve(takePendingLevel()).then(level => {
    if (!level) {
      const recipe = getRecipe(id, state.levelsSinceKeyDoor);
      level = generateFallback(seed, id, recipe);
    }
    loadLevel(level);
  });
}

// ─── move dispatcher ──────────────────────────────────────────────────────────
function handleMove(dx, dy) {
  if (state.won) return;

  if (state.isMoving) {
    // Buffer this input; overwrite any earlier queued move.
    // The timestamp lets us discard inputs that arrived too early.
    state.queuedMove = { dx, dy, queuedAt: performance.now() };
    return;
  }

  _executeMove(dx, dy);
}

// Animate chain retraction after a multi-back revisit.
// The tail smoothly rewinds along each path segment back to targetLength.
// Each segment's duration is proportional to its grid distance (same speed as forward moves).
let _retractToken = 0;
let _moveToken    = 0;
function _animateChainRetract(fromGears, targetLength, playerPos, gearsLeft, totalGears, level, onDone) {
  // Retract at the same speed as forward movement — proportional to grid distance.
  const MS_PER_CELL = 80;
  const token = ++_retractToken;

  // Build ordered waypoints: fromGears[last] → fromGears[last-1] → … → playerPos.
  const waypoints = [];
  for (let i = fromGears.length - 1; i >= targetLength; i--) waypoints.push(fromGears[i]);
  waypoints.push(targetLength > 0 ? fromGears[targetLength - 1] : playerPos);

  // Pixel coords and cumulative grid-cell distances along the waypoint path.
  const wPx = waypoints.map(w => getCellPixel(w.x, w.y, level));
  const cumDist = [0];
  for (let i = 1; i < waypoints.length; i++) {
    const d = Math.max(
      Math.abs(waypoints[i].x - waypoints[i - 1].x),
      Math.abs(waypoints[i].y - waypoints[i - 1].y),
    ) || 1;
    cumDist.push(cumDist[i - 1] + d);
  }
  const totalDist    = cumDist[cumDist.length - 1];
  const totalDurMs   = totalDist * MS_PER_CELL * getSpeedMultiplier();
  const startTime    = performance.now();

  function frame(now) {
    if (token !== _retractToken) { onDone(); return; }
    const progress = Math.min((now - startTime) / totalDurMs, 1);
    const d = progress * totalDist;

    // Which segment is the tail currently in?
    let seg = 0;
    while (seg < cumDist.length - 2 && d >= cumDist[seg + 1]) seg++;
    const segFrac = cumDist[seg + 1] > cumDist[seg]
      ? (d - cumDist[seg]) / (cumDist[seg + 1] - cumDist[seg]) : 1;
    const p1 = wPx[seg], p2 = wPx[seg + 1];
    const tailPx = { x: p1.x + (p2.x - p1.x) * segFrac, y: p1.y + (p2.y - p1.y) * segFrac };

    // Gears to render: exclude the gear currently being retracted (the tail's departure point)
    // so the chain path doesn't fold back on itself. Once the tail fully reaches the next
    // waypoint, that gear also gets excluded in the following segment.
    const keepCount = fromGears.length - 1 - seg; // excludes the current tail gear
    const gearsForRender = fromGears.slice(0, keepCount);
    drawChainWithPixelTail(gearsForRender, tailPx, gearsLeft, totalGears, level);

    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      drawChain(fromGears.slice(0, targetLength), playerPos, gearsLeft, totalGears, level);
      onDone();
    }
  }
  requestAnimationFrame(frame);
}

function _scheduleDeadEndCheck() {
  // Skip the check if the player is in the boat (y < 0) — always reachable from there.
  if (state.playerPos.y < 0) return;
  if (!canReachGoal(state.level, state.playerPos, state.worldState, state.toggleMap)) {
    _deadEndTimer = setTimeout(() => {
      if (!state.won) {
        deadEndBanner.hidden = false;
        playDeadEnd();
        function _restart() {
          deadEndBanner.hidden = true;
          deadEndBanner.removeEventListener('pointerdown', _restart);
          document.removeEventListener('keyup', _restart);
          loadLevel(state.level);
        }
        deadEndBanner.addEventListener('pointerdown', _restart, { once: true });
        document.addEventListener('keyup', _restart, { once: true });
      }
    }, 1000);
  }
}

// ─── one-way backtrack helpers ────────────────────────────────────────────────

/**
 * Returns the index in state.gears of the last gear that is on the far side
 * of the one-way at (owx, owy) when approaching in direction (dx, dy).
 * Far side: (g.x - owx)*dx + (g.y - owy)*dy > 0  (ahead of the one-way in travel direction).
 * This is the gear the chain originally passed through when traversing the one-way,
 * so backtracking always lands on an existing chain position rather than sliding past.
 */
function _findOnewayEntryGear(owx, owy, dx, dy) {
  for (let i = state.gears.length - 1; i >= 0; i--) {
    const g = state.gears[i];
    if ((g.x - owx) * dx + (g.y - owy) * dy > 0) return i;
  }
  return -1;
}

/**
 * Animate the player to state.gears[gearIdx] and shorten the chain back to it.
 * Mirrors the revisit path in _executeMove.
 */
function _executeBacktrack(gearIdx) {
  // gearIdx = -1 is a special signal meaning "backtrack all the way to the boat".
  const backtrackPos = gearIdx < 0 ? state.level.start : state.gears[gearIdx];

  state.isMoving = true;
  setChainSpinning(true, -1);

  const freed         = state.gears.length - gearIdx - 1; // works for gearIdx=-1
  const gearsSnapshot = state.gears.slice();

  state.gears     = state.gears.slice(0, gearIdx + 1); // slice(0,0) = [] for boat
  state.gearsLeft += freed;

  const moveToken = _moveToken;

  // Freed gears in forward order (from just after the backtrack target toward the player).
  // e.g. if gears were [A,B,C,D,E] and we backtrack to B: freedGears = [C,D,E].
  const freedGears = gearsSnapshot.slice(gearIdx + 1);

  // Walk the player back one freed gear at a time: E→D, D→C, C→B.
  // Before each step, strip the "from" gear from the displayed chain so the
  // chain tail cleanly follows the player rather than snapping all at once.
  // waypoints: freed gears in reverse (minus the player's starting pos) + backtrack target.
  // e.g. [D, C, B]
  const waypoints = [
    ...freedGears.slice(0, -1).reverse(),
    backtrackPos,
  ];

  let displayGears = gearsSnapshot.slice();

  function step(waypointIdx, fromPos) {
    if (moveToken !== _moveToken) return;

    // Drop a freed gear before animating so the chain tail never extends past the
    // player toward a gear they have already left.  Guard against dropping below
    // the permanent chain length (state.gears) — when there are no freed gears
    // (e.g. backtracking directly to the only cog with nothing above it), the
    // backtrack target must stay visible throughout the animation.
    if (displayGears.length > state.gears.length) {
      displayGears = displayGears.slice(0, displayGears.length - 1);
    }
    drawChain(displayGears, fromPos, state.gearsLeft, state.totalGears, state.level);

    const toPos = waypoints[waypointIdx];
    animatePlayer(fromPos, toPos, state.level, () => {
      if (moveToken !== _moveToken) return;
      state.playerPos = { x: toPos.x, y: toPos.y };

      if (waypointIdx === waypoints.length - 1) {
        state.isMoving = false;
        // Reset prevDir when backtracking to the boat so the next move doesn't
        // falsely register as a bend (which would consume a gear and place a cog
        // at the boat anchor position).
        if (gearIdx < 0) state.prevDir = null;
        drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
        setChainSpinning(false);
        _scheduleDeadEndCheck();
        _flushQueuedMove();
      } else {
        step(waypointIdx + 1, toPos);
      }
    });
  }

  step(0, state.playerPos);
}

/** Skip to the next level (debug/test shortcut). */
export function skipLevel() {
  _nextLevel();
}

/** Return the level object currently being played. */
export function getCurrentLevel() {
  return state.level;
}

function _flushQueuedMove() {
  const q = state.queuedMove;
  state.queuedMove = null;
  if (q && (performance.now() - q.queuedAt) <= QUEUE_WINDOW_MS) {
    _executeMove(q.dx, q.dy);
  }
}

function _tryOnewayBacktrack(target, dx, dy, didMove) {
  if (!target.blockedByOneway || didMove) return false;
  const { x: owx, y: owy } = target.blockedByOneway;
  state.pendingOnewayBreak = null;
  const entryIdx = _findOnewayEntryGear(owx, owy, dx, dy);
  if (entryIdx >= 0) { _executeBacktrack(entryIdx); return true; }
  const s      = state.level.start;
  const firstPt = state.gears.length > 0 ? state.gears[0] : state.playerPos;
  const onBoatSegment =
    (s.x === firstPt.x && owx === s.x &&
     Math.min(s.y, firstPt.y) <= owy && owy <= Math.max(s.y, firstPt.y)) ||
    (s.y === firstPt.y && owy === s.y &&
     Math.min(s.x, firstPt.x) <= owx && owx <= Math.max(s.x, firstPt.x));
  if (onBoatSegment && (s.x - owx) * dx + (s.y - owy) * dy > 0) { _executeBacktrack(-1); return true; }
  return false;
}

// Computes all pre-animation gear context and applies the straight-through pop.
// Returns null if the move is blocked by an empty gear budget.
function _buildDepartureCtx(target, dx, dy) {
  const isBoatEntry = target.y < 0;

  let isStraightThrough = false;
  if (!isBoatEntry && state.gears.length > 0) {
    const last = state.gears[state.gears.length - 1];
    if (last.x === state.playerPos.x && last.y === state.playerPos.y) {
      const prev = state.gears.length > 1 ? state.gears[state.gears.length - 2] : state.level.start;
      if (dx === Math.sign(last.x - prev.x) && dy === Math.sign(last.y - prev.y)) {
        isStraightThrough = true;
        state.gears.pop();
        state.gearsLeft++;
        drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
      }
    }
  }

  const isBendRaw = !isStraightThrough && state.prevDir !== null &&
    (dx !== state.prevDir.dx || dy !== state.prevDir.dy);

  let isRetractingTowardLastCog = false;
  if (isBendRaw && !isBoatEntry) {
    const anchor = state.gears.length > 0 ? state.gears[state.gears.length - 1] : state.level.start;
    isRetractingTowardLastCog =
      dx === Math.sign(anchor.x - state.playerPos.x) &&
      dy === Math.sign(anchor.y - state.playerPos.y);
  }

  const isBend = isBendRaw && !isRetractingTowardLastCog;

  const revisitIdx = isBoatEntry ? -2 : state.gears.findIndex(g => g.x === target.x && g.y === target.y);
  const isAtLastCog = state.gears.length > 0 &&
    state.gears[state.gears.length - 1].x === state.playerPos.x &&
    state.gears[state.gears.length - 1].y === state.playerPos.y;
  const willUseGear = !isBoatEntry && revisitIdx < 0 && isBend && !isAtLastCog;

  if (willUseGear && state.gearsLeft === 0) { _scheduleDeadEndCheck(); return null; }
  if (state.gearsLeft === 0 && revisitIdx >= 0 && revisitIdx < state.gears.length - 2) { _scheduleDeadEndCheck(); return null; }

  const pendingBendGear    = isBend && !isAtLastCog && !isBoatEntry && revisitIdx >= 0;
  const effectiveGearCount = state.gears.length + (pendingBendGear ? 1 : 0);
  const isOneBack = (!isBoatEntry && revisitIdx >= 0 && revisitIdx === effectiveGearCount - 2)
                 || (isBoatEntry && state.gears.length === 1);

  return { isBoatEntry, isStraightThrough, isBend, isRetractingTowardLastCog,
           revisitIdx, isAtLastCog, isOneBack, pendingBendGear };
}

// Draws the pre-animation chain state and pushes the departure cog if turning.
function _applyPreAnimationChain(ctx) {
  const { isBoatEntry, isBend, isAtLastCog, isOneBack, revisitIdx, pendingBendGear } = ctx;
  if (isOneBack && !pendingBendGear) {
    drawChain(state.gears.slice(0, revisitIdx + 1), state.playerPos, state.gearsLeft + 1, state.totalGears, state.level);
  }
  setChainSpinning(true, revisitIdx >= 0 ? -1 : 1);
  if (isBend && !isAtLastCog && !isBoatEntry) {
    state.gears.push({ x: state.playerPos.x, y: state.playerPos.y });
    state.gearsLeft--;
    if (isOneBack) {
      drawChain(state.gears.slice(0, revisitIdx + 1), state.playerPos, state.gearsLeft + 1, state.totalGears, state.level);
    } else {
      drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
    }
  }
}

function _applyCollectibles(target) {
  if (target.crumble !== null) {
    const { x: cx, y: cy, toggleIdx } = target.crumble;
    if (toggleIdx !== undefined) state.worldState |= (1 << toggleIdx);
    removeCrumble(cx, cy, state.level);
    playCrumble();
  }
  if (target.keyCollected) {
    const { x: kx, y: ky, toggleIdx } = target.keyCollected;
    if (toggleIdx !== undefined) {
      state.worldState |= (1 << toggleIdx);
      if (state.level.doorRequirements) {
        for (const [flatIdx, reqToggle] of state.level.doorRequirements) {
          if (reqToggle === toggleIdx) {
            openDoor(flatIdx % state.level.width, Math.floor(flatIdx / state.level.width), state.level);
            playDoorOpen();
          }
        }
      }
    }
    removeKey(kx, ky, state.level);
    playKeyCollect();
  }
}

function _handleWin() {
  state.won = true;
  playWin();
  state.queuedMove = null;
  setChainSpinning(false);
  winBanner.hidden = false;
  function _advance() {
    winBanner.hidden = true;
    winBanner.removeEventListener('pointerdown', _advance);
    document.removeEventListener('keyup', _advance);
    _nextLevel();
  }
  winBanner.addEventListener('pointerdown', _advance, { once: true });
  document.addEventListener('keyup', _advance, { once: true });
}

function _onPlayerLanded(target, dx, dy, ctx) {
  const { isBoatEntry, isRetractingTowardLastCog, revisitIdx, isOneBack } = ctx;

  const gearsBeforeUpdate = state.gears.slice();
  let freedOnRevisit = -1;

  if (!isBoatEntry) {
    if (revisitIdx >= 0) {
      freedOnRevisit   = state.gears.length - revisitIdx - 1;
      state.gears      = state.gears.slice(0, revisitIdx + 1);
      state.gearsLeft += freedOnRevisit;
    }
  } else {
    state.gearsLeft += state.gears.length;
    state.gears = [];
  }

  state.prevDir = isBoatEntry ? null : { dx, dy };

  if (!isBoatEntry && isRetractingTowardLastCog && revisitIdx < 0) {
    const anchor = state.gears.length > 0 ? state.gears[state.gears.length - 1] : state.level.start;
    state.prevDir = {
      dx: Math.sign(state.playerPos.x - anchor.x),
      dy: Math.sign(state.playerPos.y - anchor.y),
    };
  }

  // Compute before pending-cog pop so the pop doesn't trigger a spurious retraction.
  const needsRetractAnim = !isOneBack && gearsBeforeUpdate.length > state.gears.length
                           && (isBoatEntry ? gearsBeforeUpdate.length > 0 : revisitIdx >= 0);

  // Pending-cog pop: if the player landed exactly on the last cog with nothing freed
  // behind it, the cog hasn't committed to a bend yet — release it back to the budget.
  if (!isBoatEntry && state.gears.length > 0 && freedOnRevisit === 0) {
    const last = state.gears[state.gears.length - 1];
    if (last.x === state.playerPos.x && last.y === state.playerPos.y) {
      const prev = state.gears.length > 1 ? state.gears[state.gears.length - 2] : state.level.start;
      state.gears.pop();
      state.gearsLeft++;
      state.prevDir = { dx: Math.sign(last.x - prev.x), dy: Math.sign(last.y - prev.y) };
    }
  }

  if (needsRetractAnim) {
    state.isMoving = true;
    _animateChainRetract(gearsBeforeUpdate, state.gears.length, state.playerPos, state.gearsLeft, state.totalGears, state.level, () => {
      state.isMoving = false;
      setChainSpinning(false);
      _scheduleDeadEndCheck();
      _flushQueuedMove();
    });
  }

  _applyCollectibles(target);

  if (target.x === state.level.goal.x && target.y === state.level.goal.y) {
    _handleWin();
    return;
  }

  if (!needsRetractAnim) {
    setChainSpinning(false);
    drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
    _scheduleDeadEndCheck();
    _flushQueuedMove();
  }
}

function _executeMove(dx, dy) {
  _retractToken++;
  clearTimeout(_deadEndTimer);
  _deadEndTimer = null;
  deadEndBanner.hidden = true;

  const gearSet    = new Set(state.gears.map(g => g.y * state.level.width + g.x));
  const target     = slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState, gearSet);
  const didMove    = target.x !== state.playerPos.x || target.y !== state.playerPos.y;
  const hasCrumble = target.crumble !== null;

  if (_tryOnewayBacktrack(target, dx, dy, didMove)) return;

  if (!didMove && !hasCrumble) {
    state.pendingOnewayBreak = null;
    playBlocked();
    _scheduleDeadEndCheck();
    return;
  }
  state.pendingOnewayBreak = null;

  const ctx = _buildDepartureCtx(target, dx, dy);
  if (ctx === null) return;

  state.isMoving = true;
  playSlide();
  _applyPreAnimationChain(ctx);

  const moveToken = _moveToken;
  animatePlayer(state.playerPos, target, state.level, () => {
    if (moveToken !== _moveToken) return;
    state.playerPos = { x: target.x, y: target.y };
    state.isMoving  = false;
    playLand();
    _onPlayerLanded(target, dx, dy, ctx);
  });
}
