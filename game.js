import { slidePlayer, buildToggleMap, canReachGoal, canReachAnyOf, CellType, onewayAllows } from './puzzle.js';
import { solve } from './solver.js';
import { makeRng } from './random.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays, drawChain, drawChainWithPixelTail, getCellPixel, setChainSpinning, setTailGearSpinning, removeCrumble, removeKey, openDoor, getSpeedMultiplier, setSpeedMultiplier, setChainLengthTotal, setGoalFollowsPlayer } from './renderer.js';
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

// Set to true while auto-play is running; cleared on cancel or level load.
let _autoPlaying = false;

// Incremented every time loadLevel() is called — lets batch playthrough await the next level.
let _levelLoadCount = 0;

// { onWin, onStuck } callbacks set during a batch playthrough.
// Intercepted by _handleWin and _scheduleDeadEndCheck instead of showing banners.
let _batchHook = null;

// When true, chain-length and gear-count hard stops are bypassed so auto-play
// can finish levels that the generator under-budgeted.  Violations are recorded
// in _batchViolations and reported as failures even if the level completes.
let _batchBypassConstraints = false;
// { chainExceeded, gearsExhausted, chainWasDepleted } — set during play, read at win
let _batchViolations = null;

// True while runBatchPlaythrough is active.
let _batchRunning = false;
// True once stopBatchPlaythrough() is called — signals the loop to exit.
let _batchStopped = false;
// When true, skip win retract animation and use minimal move delays.
let _batchFast = false;

// Actual step-by-step execution log collected during auto-play.
// Each entry: { idx, move, fromPos, toPos, chainBefore, chainAfter, gearsBefore, gearsAfter, wsAfter }
let _execTrace = [];

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
  // Gear chain system.
  gears:                [],     // [{x,y}] cog positions (bends/reversals only)
  gearsLeft:            0,      // remaining gear budget
  totalGears:           0,      // starting budget (used for display/scoring)
  chainLengthTotal:     0,      // total chain length allowed for this level
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

// ─── teleporter test level (?tp in URL) ──────────────────────────────────────
//
// 5-column × 6-row grid.  Boat enters above column 2.
//
//   0 1 2 3 4
// 0 . . . . .
// 1 # . . . #
// 2 # . T . #   T at (2,2) ↔ T at (2,4)
// 3 # . . . #
// 4 # . T . #
// 5 G . . . .
//
// Path: (2,-1) down → hits T(2,2), exits T(2,4) → slides to (2,5) → go left → (0,5) = goal.
function _makeTeleporterTestLevel() {
  const E = CellType.EMPTY, W = CellType.WALL, T = CellType.TELEPORTER;
  const width = 5, height = 6;
  const cells = new Uint8Array([
    E, E, E, E, E,
    W, E, E, E, W,
    W, E, T, E, W,
    W, E, E, E, W,
    W, E, T, E, W,
    E, E, E, E, E,
  ]);
  // teleporterMap: (2,2) ↔ (2,4)
  const tp1 = 2 * width + 2;  // flat index of (2,2)
  const tp2 = 4 * width + 2;  // flat index of (2,4)
  const teleporterMap = new Map([[tp1, tp2], [tp2, tp1]]);
  return {
    id: 'tp-test', seed: 0, width, height,
    cells,
    start: { x: 2, y: -1 },
    goal:  { x: 0, y: 5 },
    teleporterMap,
    effectiveChainLength: 20,
    effectiveCogs: 3,
  };
}

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

  const urlParams = new URLSearchParams(window.location.search);
  loadLevel(urlParams.has('tp') ? _makeTeleporterTestLevel() : SAMPLE_LEVELS[0]);
}

// ─── level loading ────────────────────────────────────────────────────────────
function loadLevel(level) {
  _autoPlaying = false;
  _batchHook   = null;
  _execTrace   = [];
  _levelLoadCount++;
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

  // Gear budget: max of goal depth and any key depths so the player always has
  // enough gears to collect every key in the level before reaching the goal.
  const goalDepth = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x]
    : 0;
  const budget = (level.effectiveCogs ?? goalDepth) > 0 ? (level.effectiveCogs ?? goalDepth) : 1;
  state.gears             = [];
  state.gearsLeft         = budget;
  state.totalGears        = budget;
  const chainBudget       = (level.effectiveChainLength ?? 0) > 0 ? level.effectiveChainLength : (level.width + level.height);
  state.chainLengthTotal  = chainBudget;
  setChainLengthTotal(chainBudget);

  if (levelLabel) levelLabel.textContent = `Level ${level.id}`;

  // Debug: show cog budget breakdown when a key requires more gears than the direct goal path.
  const cogDebugEl = document.getElementById('cog-debug');
  if (cogDebugEl) {
    if (level.keyDepths && level.keyDepths.length > 0) {
      const hasOverrun = level.keyDepths.some(k => k.depth > goalDepth);
      const keyParts   = level.keyDepths.map(k => `K(${k.x},${k.y})=${k.depth >= 0 ? k.depth : '?'}`).join(' ');
      cogDebugEl.textContent = `goal=${goalDepth} ${keyParts} → budget=${budget}${hasOverrun ? '  ⚠ key>goal' : ''}`;
      cogDebugEl.dataset.overrun = hasOverrun ? '1' : '';
      cogDebugEl.hidden = false;
    } else {
      cogDebugEl.hidden = true;
    }
  }
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

const MOVE_MS_PER_CELL        = 80; // normal player movement speed
const FAST_RETRACT_MS_PER_CELL = 50; // retraction speed when player is standing still

// Animate chain retraction after a multi-back revisit.
// The tail smoothly rewinds along each path segment back to targetLength.
// Each segment's duration is proportional to its grid distance (same speed as forward moves).
let _retractToken = 0;
let _moveToken    = 0;
function _animateChainRetract(fromGears, targetLength, playerPos, gearsLeft, totalGears, level, onDone, tailEndOverride = null, tailStartOverride = null, suppressTailSpin = false, msPerCell = MOVE_MS_PER_CELL) {
  const token = ++_retractToken;

  // Build ordered waypoints: tailStart → fromGears[last] → … → tailEnd.
  // Teleport crossings are not physical bend waypoints — skip them so the
  // retract animation doesn't try to animate through the teleport gap.
  const waypoints = [];
  if (tailStartOverride) waypoints.push(tailStartOverride);
  for (let i = fromGears.length - 1; i >= targetLength; i--) {
    if (!fromGears[i].isTeleport) waypoints.push(fromGears[i]);
  }
  waypoints.push(tailEndOverride ?? (targetLength > 0 ? fromGears[targetLength - 1] : playerPos));

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
  const totalDurMs   = totalDist * msPerCell * getSpeedMultiplier();
  const startTime    = performance.now();

  if (suppressTailSpin) setTailGearSpinning(false);

  function frame(now) {
    if (token !== _retractToken) { if (suppressTailSpin) setTailGearSpinning(true); onDone(); return; }
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
    const keepCount = fromGears.length - seg - (tailStartOverride ? 0 : 1); // excludes the current tail gear
    const gearsForRender = fromGears.slice(0, keepCount);
    drawChainWithPixelTail(gearsForRender, tailPx, gearsLeft, totalGears, level);

    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      if (suppressTailSpin) setTailGearSpinning(true);
      drawChain(fromGears.slice(0, targetLength), playerPos, gearsLeft, totalGears, level);
      onDone();
    }
  }
  requestAnimationFrame(frame);
}

function _scheduleDeadEndCheck() {
  // Skip the check if the player is in the boat (y < 0) — always reachable from there.
  if (state.playerPos.y < 0) return;

  // Find uncollected key positions still present in the level.
  const { cells, width, goal } = state.level;
  const uncollectedKeys = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === CellType.KEY) {
      const tIdx = state.toggleMap?.get(i);
      if (tIdx === undefined || (state.worldState & (1 << tIdx)) === 0) {
        uncollectedKeys.push({ x: i % width, y: Math.floor(i / width) });
      }
    }
  }

  // Check reachability from the current player position AND every cog already
  // placed on the chain — the player can backtrack to any of them for free.
  const startPositions = [state.playerPos, ...state.gears];
  const targets = uncollectedKeys.length > 0
    ? [goal, ...uncollectedKeys].filter(Boolean)
    : [goal].filter(Boolean);

  const stuck = !startPositions.some(p =>
    canReachAnyOf(state.level, p, targets, state.worldState, state.toggleMap)
  );

  if (stuck) {
    _deadEndTimer = setTimeout(() => {
      if (!state.won) {
        playDeadEnd();
        if (_batchHook) {
          _autoPlaying = false;
          const h = _batchHook; _batchHook = null; h.onStuck('dead-end');
        } else {
          _showBanner(deadEndBanner, () => loadLevel(state.level));
        }
      }
    }, 1000);
  }
}

// ─── backtrack helpers ───────────────────────────────────────────────────────

// Returns true if the player is strictly between two consecutive chain points
// that travel in direction (dx, dy) and whose forward endpoint is `target`.
// ─── one-way backtrack helpers ────────────────────────────────────────────────

/**
 * Returns the index in state.gears of the last gear that is on the far side
 * of the one-way at (owx, owy) when approaching in direction (dx, dy).
 * Far side: (g.x - owx)*dx + (g.y - owy)*dy > 0  (ahead of the one-way in travel direction).
 * This is the gear the chain originally passed through when traversing the one-way,
 * so backtracking always lands on an existing chain position rather than sliding past.
 */
function _findOnewayEntryGear(owx, owy, dx, dy) {
  // Walk chain segments; find the first one that passes through (owx,owy)
  // in the oneway's allowed direction (-dx,-dy). Returns the gear index of
  // the waypoint on the far side (-1 = start), or null if chain never crossed.
  const chain = [state.level.start, ...state.gears, state.playerPos];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1];
    const segDx = Math.sign(b.x - a.x);
    const segDy = Math.sign(b.y - a.y);
    if (segDx !== -dx || segDy !== -dy) continue;
    const onSeg = segDy === 0
      ? (owy === a.y && Math.min(a.x, b.x) < owx && owx < Math.max(a.x, b.x))
      : (owx === a.x && Math.min(a.y, b.y) < owy && owy < Math.max(a.y, b.y));
    if (onSeg) return i - 1; // i=0 → -1 means backtrack to start
  }
  return null;
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

  const gearsSnapshot = state.gears.slice();
  // Only bend gears (non-teleport) consume gear budget — count them for the refund.
  const freed = gearsSnapshot.slice(gearIdx + 1).filter(g => !g.isTeleport).length;

  state.gears     = state.gears.slice(0, gearIdx + 1); // slice(0,0) = [] for boat
  state.gearsLeft += freed;

  const moveToken = _moveToken;

  // Freed gears in forward order (from just after the backtrack target toward the player).
  // e.g. if gears were [A,B,C,D,E] and we backtrack to B: freedGears = [C,D,E].
  const freedGears = gearsSnapshot.slice(gearIdx + 1);

  // Walk the player back through bend waypoints only — teleport crossings are not
  // physical positions the player animates to.
  // waypoints: freed REAL gears in reverse + backtrack target. e.g. [D, C, B]
  const freedBend = freedGears.filter(g => !g.isTeleport);
  const waypoints = [
    ...freedBend.slice(0, -1).reverse(),
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
        // Pending-cog pop: the player just landed on the last gear — it hasn't
        // committed to a new bend yet, so release it (mirrors _onPlayerLanded).
        if (gearIdx >= 0 && state.gears.length > 0) {
          const last = state.gears[state.gears.length - 1];
          if (!last.isTeleport && last.x === state.playerPos.x && last.y === state.playerPos.y) {
            const prev = state.gears.length > 1
              ? _gearOutPos(state.gears[state.gears.length - 2])
              : state.level.start;
            state.gears.pop();
            state.gearsLeft++;
            state.prevDir = { dx: Math.sign(last.x - prev.x), dy: Math.sign(last.y - prev.y) };
          }
        }
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

/**
 * Deterministically compute the seed and levelsSinceKeyDoor at level n by
 * simulating the full progression from level 2, using the level seed itself
 * as the RNG source for key/door decisions so the result is always the same.
 */
function _computeProgressionForLevel(n) {
  let seed         = 300;
  let sinceKeyDoor = 0;
  for (let i = 2; i < n; i++) {
    const recipe  = getRecipe(i, sinceKeyDoor, makeRng(seed));
    sinceKeyDoor  = recipe.useKeyDoor ? 0 : sinceKeyDoor + 1;
    seed         += recipe.candidates;
  }
  return { seed, sinceKeyDoor };
}

/**
 * Jump directly to any level number.  Always produces the same level for a
 * given n: seed and key/door decisions are computed deterministically from
 * the level index, and generateFallback provides a fixed candidate count.
 */
export function jumpToLevel(n) {
  n = Math.max(1, Math.floor(n));

  if (n === 1) {
    state.levelIndex         = 1;
    state.nextId             = 2;
    state.nextSeed           = 300;
    state.levelsSinceKeyDoor = 0;
    loadLevel(SAMPLE_LEVELS[0]);
    return;
  }

  const { seed, sinceKeyDoor } = _computeProgressionForLevel(n);
  const recipe = getRecipe(n, sinceKeyDoor, makeRng(seed));
  const level  = generateFallback(seed, n, recipe);

  // Set progression state before loadLevel so it pregens the right next level.
  state.levelIndex         = n;
  state.nextId             = n + 1;
  state.nextSeed           = seed + recipe.candidates;
  state.levelsSinceKeyDoor = level.doorRequirements?.size > 0 ? 0 : sinceKeyDoor + 1;

  loadLevel(level);
}

/** Return the level object currently being played. */
export function getCurrentLevel() {
  return state.level;
}

/** Start auto-playing a solution to the current level. */
export function autoPlay() {
  if (_autoPlaying || state.won) return;
  const solverStart = { ...state.playerPos };
  const moves = solve(state.level, solverStart, state.worldState, state.toggleMap, Math.max(0, state.level.effectiveChainLength - _chainLengthUsed()), state.level.effectiveCogs, { dx: 0, dy: 1 });
  if (!moves) {
    _logPlaythroughFailure(state.level, state.levelIndex, 'solver found no path', [], solverStart);
    return;
  }
  const initialWorldState = state.worldState;
  _autoPlaying = true;
  _batchHook = {
    onWin:   ()  => _showBanner(winBanner, _nextLevel),
    onStuck: r   => {
      _logPlaythroughFailure(state.level, state.levelIndex, r, moves, solverStart, initialWorldState);
      if (r === 'dead-end') _showBanner(deadEndBanner, () => loadLevel(state.level));
    },
  };
  _autoPlayNext(moves, 0);
}

/** Cancel an in-progress auto-play. */
export function stopAutoPlay() {
  _autoPlaying = false;
}

/**
 * Start an infinite batch playthrough that runs until stopBatchPlaythrough() is called.
 * Uses fast animation speed and skips the win retract animation.
 * Returns a promise that resolves when the batch ends.
 */
export async function runBatchPlaythrough() {
  if (_batchRunning) return;

  _batchRunning         = true;
  _batchStopped         = false;
  _batchFast            = true;
  _batchBypassConstraints = true;
  setSpeedMultiplier(0.05); // 20× faster animations

  let failures = 0, total = 0;
  let seed = 300, id = 2, levelIdx = 2, sinceKeyDoor = 0, levelNum = 0;

  console.group('Batch playthrough: ∞ (click stop to end)');

  try {
    while (!_batchStopped) {
      levelNum++;
      let level;
      if (levelNum === 1) {
        level = SAMPLE_LEVELS[0];
      } else {
        const recipe = getRecipe(levelIdx, sinceKeyDoor, makeRng(seed));
        level = generateFallback(seed, id, recipe);
        sinceKeyDoor = recipe.useKeyDoor ? 0 : sinceKeyDoor + 1;
        seed += recipe.candidates;
        id++; levelIdx++;
      }

      total++;
      _batchViolations = { chainExceeded: false, gearsExhausted: false, chainWasDepleted: false, teleportUsed: false };

      const prevCount = _levelLoadCount;
      loadLevel(level);
      await _waitForNewLevel(prevCount);

      if (_batchStopped) break;

      const solverStart       = { ...state.playerPos };
      const initialWorldState = state.worldState;
      const moves = solve(level, solverStart, state.worldState, state.toggleMap, Math.max(0, level.effectiveChainLength - _chainLengthUsed()), level.effectiveCogs, { dx: 0, dy: 1 });

      let outcome;
      if (!moves) {
        outcome = 'solver found no path';
      } else {
        outcome = await new Promise(resolve => {
          _batchHook = { onWin: () => resolve('won'), onStuck: r => resolve(r) };
          _autoPlaying = true;
          _autoPlayNext(moves, 0);
        });
      }

      if (outcome === 'stopped') break;

      if (outcome === 'won') {
        const { chainExceeded, gearsExhausted, chainWasDepleted, teleportUsed } = _batchViolations;
        const chainFinallyDepleted = chainWasDepleted ||
          (state.chainLengthTotal > 0 && _chainLengthUsed() >= state.chainLengthTotal);
        const chainTooShort = chainExceeded;
        const chainTooLong  = !chainExceeded && !chainFinallyDepleted && state.chainLengthTotal > 0;
        const gearsTooFew   = gearsExhausted;
        const gearsTooMany  = !gearsExhausted && state.gearsLeft > 0;

        const issues = [
          chainTooShort && 'chain too short (bypassed)',
          chainTooLong  && 'chain too long (never depleted)',
          gearsTooFew   && 'gears too few (bypassed)',
          gearsTooMany  && 'gears too many (underused)',
        ].filter(Boolean);

        if (issues.length) {
          failures++;
          const hasTeleporter = level.teleporterMap?.size > 0;
          console.group(`%cLevel ${levelNum} — completed but generator miscalculated: ${issues.join(', ')}`, 'color:#e80; font-weight:bold');
          console.log(`Issues: ${issues.join(', ')}`);
          console.log(`Chain: limit ${state.chainLengthTotal}, used at win ${_chainLengthUsed()}, ever depleted: ${chainFinallyDepleted}`);
          console.log(`Gears: budget ${state.totalGears}, remaining at win ${state.gearsLeft}`);
          console.log(`Teleporter: ${hasTeleporter ? `yes — path ${teleportUsed ? 'USED' : 'did not use'} one` : 'none'}`);
          console.log('Seed:', level.seed, '  Size:', `${level.width}×${level.height}`);
          if (moves) {
            const arrows = { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' };
            console.log(`Planned moves (${moves.length}):`, moves.map(m => arrows[`${m.dx},${m.dy}`] ?? '?').join(' '));
          }
          console.log('Level JSON:', JSON.stringify({ id: level.id, seed: level.seed, width: level.width, height: level.height, start: level.start, goal: level.goal, effectiveChainLength: level.effectiveChainLength, effectiveCogs: level.effectiveCogs }));
          console.groupEnd();
        } else {
          console.log(`Level ${levelNum}: ✓`);
        }
      } else {
        failures++;
        _logPlaythroughFailure(level, levelNum, outcome, moves, solverStart, initialWorldState);
      }
    }
  } finally {
    _batchRunning         = false;
    _batchFast            = false;
    _batchStopped         = false;
    _batchBypassConstraints = false;
    _batchViolations      = null;
    setSpeedMultiplier(1);
  }

  if (failures === 0) {
    console.log(`Stopped after ${total} levels — all passed ✓`);
  } else {
    console.warn(`Stopped after ${total} levels — ${failures}/${total} failed`);
  }
  console.groupEnd();
}

/** Stop an in-progress runBatchPlaythrough. */
export function stopBatchPlaythrough() {
  if (!_batchRunning) return;
  _batchStopped = true;
  _autoPlaying  = false;
  if (_batchHook) { const h = _batchHook; _batchHook = null; h.onStuck('stopped'); }
}

/** Poll until a new level has loaded and its initial slide animation is done. */
function _waitForNewLevel(prevCount) {
  return new Promise(resolve => {
    function check() {
      if (_levelLoadCount !== prevCount && !state.isMoving) { resolve(); return; }
      setTimeout(check, 50);
    }
    setTimeout(check, 50);
  });
}

function _logPlaythroughFailure(level, displayNum, reason, plannedMoves, solverStart, initialWorldState = 0) {
  const goalDepth  = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x] : 0;
  const gearBudget = (level.effectiveCogs ?? goalDepth) > 0
    ? (level.effectiveCogs ?? goalDepth) : 1;
  const ARROW = { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' };

  console.group(`%cLevel ${displayNum} — ${reason}`, 'color:#e05; font-weight:bold');
  console.log(`%cFailure reason: ${reason}`, 'color:#e05; font-weight:bold');
  console.log(
    '%c[AI] Paste this entire console group into Claude and ask it to read CLAUDE.md first.\n' +
    'Quick field guide:\n' +
    '  • "Boat entry" = level.start (y=-1), always above the grid — NOT where planned moves begin.\n' +
    '  • "Solver started at" = where the player landed after the automatic slide-in from the boat. ALL planned moves begin here.\n' +
    '  • "Player stopped at" = where the player is when this failure was detected (after all planned moves executed, or when dead-end fired).\n' +
    '  • "Chain length (actual)" = Manhattan distance of the live chain: boat → each gear waypoint → player. NOT total cells traveled.\n' +
    '  • "Gear waypoints" = the bend positions in the chain at failure time, in order from boat to player.',
    'color:#888;font-style:italic'
  );
  console.log('Seed:', level.seed, '  Size:', `${level.width}×${level.height}`);
  console.log('Boat entry (y=-1):', level.start, '  Goal:', level.goal);
  if (solverStart) console.log('Solver started at:', solverStart, ' ← planned moves begin here');
  console.log('Chain limit:', state.chainLengthTotal, '  Gear budget:', gearBudget);
  console.log('Player stopped at:', { ...state.playerPos },
              '  World state:', state.worldState.toString(2).padStart(8, '0'));
  console.log('Chain length (actual, boat→waypoints→player):', _chainLengthUsed(), '/', state.chainLengthTotal,
              '  Gears left:', state.gearsLeft, '/', state.totalGears);
  console.log('Gear waypoints at failure:', state.gears.length ? JSON.stringify(state.gears) : '(none)');

  // Toggle map — list every toggle-bearing cell so Claude doesn't have to scan the cells array.
  // Format: "toggle N: TYPE at (x,y) [ACTIVE]"
  const TNAME = { [CellType.CRUMBLE]: 'CRUMBLE', [CellType.KEY]: 'KEY' };
  const tmLines = [];
  if (state.toggleMap?.size) {
    for (const [fi, ti] of [...state.toggleMap.entries()].sort((a, b) => a[1] - b[1])) {
      const tx = fi % level.width, ty = Math.floor(fi / level.width);
      const active = (state.worldState & (1 << ti)) !== 0;
      tmLines.push(`  toggle ${ti}: ${TNAME[level.cells[fi]] ?? 'UNKNOWN'} at (${tx},${ty})${active ? ' [ACTIVE]' : ''}`);
    }
  }
  if (level.doorRequirements?.size) {
    for (const [dfi, req] of level.doorRequirements.entries()) {
      const dx2 = dfi % level.width, dy2 = Math.floor(dfi / level.width);
      const open = (state.worldState & (1 << req)) !== 0;
      tmLines.push(`  door at (${dx2},${dy2}) requires toggle ${req}${open ? ' [OPEN]' : ' [LOCKED]'}`);
    }
  }
  if (tmLines.length) console.log('Toggle map + doors:\n' + tmLines.join('\n'));

  if (plannedMoves?.length) {
    console.log('Planned moves (' + plannedMoves.length + '):',
      plannedMoves.map(m => ARROW[`${m.dx},${m.dy}`] ?? `(${m.dx},${m.dy})`).join(' '));
  }

  // Re-simulate the solver's planned path from scratch to show expected vs actual.
  // chainAvail uses solver's formula (limit − total cells traveled), NOT _chainLengthUsed().
  if (plannedMoves?.length && solverStart) {
    const chainLimit = state.chainLengthTotal > 0 ? state.chainLengthTotal : (level.width + level.height);
    let tx = solverStart.x, ty = solverStart.y;
    let tws = initialWorldState;
    let traveled = 0;
    const freshTmap = buildToggleMap(level.cells);
    const traceLines = [`  (solver starts at (${tx},${ty}) worldState:${tws.toString(2).padStart(8,'0')} chainLimit:${chainLimit})`];
    for (let i = 0; i < plannedMoves.length; i++) {
      const { dx, dy } = plannedMoves[i];
      const avail = Math.max(0, chainLimit - traveled);
      const r = slidePlayer(level, { x: tx, y: ty }, dx, dy, freshTmap, tws, null, avail);
      let nws = tws;
      if (r.crumble?.toggleIdx      !== undefined) nws |= (1 << r.crumble.toggleIdx);
      if (r.keyCollected?.toggleIdx !== undefined) nws |= (1 << r.keyCollected.toggleIdx);
      const cells = Math.abs(r.x - tx) + Math.abs(r.y - ty);
      traveled += cells;
      const arrow = ARROW[`${dx},${dy}`] ?? `(${dx},${dy})`;
      const notes = [];
      if (r.crumble)      notes.push(`crumble@(${r.crumble.x},${r.crumble.y}) breaks`);
      if (r.keyCollected) notes.push(`key collected@(${r.keyCollected.x},${r.keyCollected.y})`);
      if (cells === 0)    notes.push('zero-move');
      traceLines.push(
        `  ${i+1}. ${arrow}: (${tx},${ty})→(${r.x},${r.y})  cells:${cells}  traveled:${traveled}/${chainLimit}  avail_was:${avail}  ws:${nws.toString(2).padStart(8,'0')}` +
        (notes.length ? `  [${notes.join(', ')}]` : '')
      );
      tx = r.x; ty = r.y; tws = nws;
    }
    traceLines.push(`  (solver expected goal at (${level.goal.x},${level.goal.y}))`);
    console.log('Solver path re-simulation (chainAvail = limit − total traveled, NOT actual chain length):\n' + traceLines.join('\n'));
  }

  // Actual execution trace — what the game really did, step by step.
  // chain = _chainLengthUsed() = Manhattan distance boat→waypoints→player (NOT total traveled).
  // Compare with solver re-simulation above to find the divergence point.
  if (_execTrace.length) {
    const execLines = [`  (chain = actual Manhattan distance of live chain, NOT total cells traveled)`];
    for (const e of _execTrace) {
      const arrow = ARROW[`${e.move.dx},${e.move.dy}`] ?? `(${e.move.dx},${e.move.dy})`;
      const toStr    = e.toPos    !== null ? `(${e.toPos.x},${e.toPos.y})` : '(pending)';
      const chainStr = e.chainAfter !== null
        ? `chain:${e.chainBefore}→${e.chainAfter}/${state.chainLengthTotal}`
        : `chain:${e.chainBefore}/?`;
      const gearsStr = e.gearsAfter !== null
        ? `gears:${e.gearsBefore}→${e.gearsAfter}`
        : `gears:${e.gearsBefore}→?`;
      const wsStr = e.wsAfter !== null ? e.wsAfter.toString(2).padStart(8, '0') : '????????';
      execLines.push(`  ${e.idx}. ${arrow}: (${e.fromPos.x},${e.fromPos.y})→${toStr}  ${chainStr}  ${gearsStr}  ws:${wsStr}`);
    }
    console.log('Actual execution trace (real game state after each move):\n' + execLines.join('\n'));
  }

  console.log('Grid:\n' + _renderGrid(level));
  console.log('Level JSON:\n' + JSON.stringify({
    id: level.id, seed: level.seed,
    width: level.width, height: level.height,
    start: level.start, goal: level.goal,
    effectiveChainLength: level.effectiveChainLength,
    effectiveCogs:        level.effectiveCogs,
    goalDifficulty:       level.goalDifficulty,
    cells:                Array.from(level.cells),
    doorRequirements:     level.doorRequirements
      ? Array.from(level.doorRequirements.entries()).map(([fi, req]) => {
          const x = fi % level.width, y = Math.floor(fi / level.width);
          return { door: { x, y, flatIdx: fi }, requiresToggle: req };
        }) : [],
  }, null, 2));
  console.groupEnd();
}

/** Render a level's grid as a readable ASCII string with x/y coordinate labels. */
function _renderGrid(level) {
  const SYM  = ['.', '#', 'S', '←', '→', '↑', '↓', 'c', 'K', 'D', 'T'];
  const { width, height, cells, start, goal } = level;
  const lines = [];
  // Column header: x=0,1,2,...
  const colHeader = '     ' + Array.from({ length: width }, (_, x) => String(x).padStart(2)).join('');
  lines.push(colHeader);
  lines.push('     ' + '--'.repeat(width));
  for (let y = 0; y < height; y++) {
    let row = `y=${String(y).padEnd(2)} `;
    for (let x = 0; x < width; x++) {
      if (x === goal.x  && y === goal.y)                 { row += 'G '; continue; }
      if (x === start.x && y === 0 && start.y < 0)       { row += '^ '; continue; }
      row += (SYM[cells[y * width + x]] ?? '?') + ' ';
    }
    lines.push(row.trimEnd());
  }
  return lines.join('\n');
}

function _autoPlayNext(moves, idx) {
  if (state.won || !_autoPlaying) { _autoPlaying = false; return; }
  if (state.isMoving) { setTimeout(() => _autoPlayNext(moves, idx), _batchFast ? 10 : 50); return; }

  // Animation settled — fill in the "after" side of the previous move's trace entry.
  if (idx > 0 && _execTrace.length >= idx) {
    const entry = _execTrace[idx - 1];
    if (entry && entry.toPos === null) {
      entry.toPos      = { ...state.playerPos };
      entry.chainAfter = _chainLengthUsed();
      entry.gearsAfter = state.gearsLeft;
      entry.wsAfter    = state.worldState;
    }
  }

  if (idx >= moves.length) {
    // All moves dispatched and last animation settled — no win means divergence.
    _autoPlaying = false;
    if (_batchHook) {
      const h = _batchHook; _batchHook = null;
      h.onStuck('solver path exhausted without reaching goal (chain mismatch?)');
    }
    return;
  }

  // Capture pre-state for this move (post-state filled on next settled tick above).
  _execTrace.push({
    idx:         idx + 1,
    move:        moves[idx],
    fromPos:     { ...state.playerPos },
    chainBefore: _chainLengthUsed(),
    gearsBefore: state.gearsLeft,
    wsBefore:    state.worldState,
    toPos:       null,
    chainAfter:  null,
    gearsAfter:  null,
    wsAfter:     null,
  });

  handleMove(moves[idx].dx, moves[idx].dy);
  setTimeout(() => _autoPlayNext(moves, idx + 1), _batchFast ? 0 : 50);
}

function _showBanner(bannerEl, onDismiss) {
  bannerEl.hidden = false;
  function dismiss() {
    bannerEl.hidden = true;
    bannerEl.removeEventListener('pointerdown', dismiss);
    document.removeEventListener('keyup', dismiss);
    onDismiss();
  }
  bannerEl.addEventListener('pointerdown', dismiss, { once: true });
  document.addEventListener('keyup', dismiss, { once: true });
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
  // Only backtrack when pressing directly against the oneway's allowed direction.
  if (!onewayAllows(state.level.cells[owy * state.level.width + owx], -dx, -dy)) return false;
  const entryIdx = _findOnewayEntryGear(owx, owy, dx, dy);
  if (entryIdx !== null) { _executeBacktrack(entryIdx); return true; }
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
      // Use effective outgoing position for direction check so teleport crossings
      // don't falsely report wrong direction.
      const prev = state.gears.length > 1
        ? _gearOutPos(state.gears[state.gears.length - 2])
        : state.level.start;
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
    // Use outgoing position so teleport crossings compare against exit, not entry.
    const anchor = state.gears.length > 0
      ? _gearOutPos(state.gears[state.gears.length - 1])
      : state.level.start;
    isRetractingTowardLastCog =
      dx === Math.sign(anchor.x - state.playerPos.x) &&
      dy === Math.sign(anchor.y - state.playerPos.y);
  }

  const isBend = isBendRaw && !isRetractingTowardLastCog;

  const revisitIdx = isBoatEntry ? -2 : state.gears.findIndex(g => g.x === target.x && g.y === target.y);
  const _lastG    = state.gears.length > 0 ? state.gears[state.gears.length - 1] : null;
  const isAtLastCog = _lastG !== null && !_lastG.isTeleport &&
    _lastG.x === state.playerPos.x && _lastG.y === state.playerPos.y;
  const willUseGear = !isBoatEntry && revisitIdx < 0 && isBend && !isAtLastCog;

  // 0 gears → simple V, skip placement.
  // 1 gear  → pop it and retract cleanly instead of creating a V.
  // 2+ gears → real loop; place the gear normally.
  // Count only real bend gears (not teleport crossings) for this shape decision.
  const bendGearCount = _bendGears().length;
  const isBoatVShapeRetract = isBoatEntry && isBend && !isAtLastCog && bendGearCount === 1;

  if (willUseGear && state.gearsLeft === 0) {
    if (_batchBypassConstraints) { _batchViolations.gearsExhausted = true; }
    else { _scheduleDeadEndCheck(); return null; }
  }
  if (isBoatEntry && isBend && !isAtLastCog && bendGearCount >= 2 && state.gearsLeft === 0) {
    if (_batchBypassConstraints) { _batchViolations.gearsExhausted = true; }
    else { _scheduleDeadEndCheck(); return null; }
  }
  if (state.gearsLeft === 0 && revisitIdx >= 0 && revisitIdx < state.gears.length - 2) {
    if (_batchBypassConstraints) { _batchViolations.gearsExhausted = true; }
    else { _scheduleDeadEndCheck(); return null; }
  }

  const pendingBendGear    = isBend && !isAtLastCog && !isBoatEntry && revisitIdx >= 0;
  const effectiveGearCount = state.gears.length + (pendingBendGear ? 1 : 0);
  const isOneBack = (!isBoatEntry && revisitIdx >= 0 && revisitIdx === effectiveGearCount - 2)
                 || (isBoatEntry && _bendGears().length === 1);

  return { isBoatEntry, isStraightThrough, isBend, isRetractingTowardLastCog,
           revisitIdx, isAtLastCog, isOneBack, pendingBendGear, isBoatVShapeRetract };
}

// Draws the pre-animation chain state and pushes the departure cog if turning.
function _applyPreAnimationChain(ctx, hasTeleportCrossing = false) {
  const { isBoatEntry, isBend, isAtLastCog, isOneBack, revisitIdx, pendingBendGear, isBoatVShapeRetract } = ctx;
  // Skip the truncated-gears drawChain when a teleport crossing is involved — the
  // bridge must remain in _chainState so Phase 1 draws correctly through the teleporter.
  if (isOneBack && !pendingBendGear && !hasTeleportCrossing) {
    drawChain(state.gears.slice(0, revisitIdx + 1), state.playerPos, state.gearsLeft + 1, state.totalGears, state.level);
  }
  setChainSpinning(true, revisitIdx >= 0 ? -1 : 1);
  if (isBoatVShapeRetract) {
    state.gears.pop();
    state.gearsLeft++;
    drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
  } else if (isBend && !isAtLastCog && (!isBoatEntry || state.gears.length >= 2)) {
    state.gears.push({ x: state.playerPos.x, y: state.playerPos.y });
    state.gearsLeft--;
    if (isOneBack && !hasTeleportCrossing) {
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

function _animateWinRetract(onDone) {
  const gearsSnapshot = state.gears.slice();

  // Build the retract step list by walking gears in reverse (player→boat direction).
  // Teleport crossings require a reverse-flash: enter at exit side, emerge at entry side.
  const steps = [];
  for (const g of [...gearsSnapshot].reverse()) {
    if (g.isTeleport) {
      const gRef = g;
      steps.push({
        toPos:        { x: g.x, y: g.y },
        teleportInfo: {
          entryPos: { x: g.exitX, y: g.exitY },
          exitPos:  { x: g.x,     y: g.y     },
          onTeleportCrossing: () => {
            // Remove this crossing from the live display so the chain doesn't show
            // a backwards segment from exit to the player appearing at entry.
            displayGears = displayGears.filter(dg => dg !== gRef);
            drawChain(displayGears, { x: gRef.x, y: gRef.y },
                      state.gearsLeft, state.totalGears, state.level);
            // The removal above counts as the gear-drop for the next step,
            // so the next step must not drop another gear.
            skipNextDrop = true;
          },
        },
      });
    } else {
      steps.push({ toPos: { x: g.x, y: g.y }, teleportInfo: null });
    }
  }
  steps.push({ toPos: state.level.start, teleportInfo: null });

  let displayGears  = gearsSnapshot.slice();
  let skipNextDrop  = false;

  setChainSpinning(true, -1);
  setGoalFollowsPlayer(true);

  function step(stepIdx, fromPos) {
    // Drop the last gear from display after the first step (player has left that position).
    // Skip when onTeleportCrossing already removed the crossing — it counts as the drop.
    if (stepIdx > 0 && displayGears.length > 0 && !skipNextDrop) {
      displayGears = displayGears.slice(0, displayGears.length - 1);
    }
    skipNextDrop = false;
    drawChain(displayGears, fromPos, state.gearsLeft, state.totalGears, state.level);

    const { toPos, teleportInfo } = steps[stepIdx];
    animatePlayer(fromPos, toPos, state.level, () => {
      if (stepIdx === steps.length - 1) {
        setChainSpinning(false);
        setGoalFollowsPlayer(false);
        onDone();
      } else {
        step(stepIdx + 1, toPos);
      }
    }, teleportInfo);
  }

  step(0, state.playerPos);
}

function _handleWin() {
  state.won = true;
  playWin();
  state.queuedMove = null;
  if (_batchFast) {
    // Skip retract animation during batch testing
    if (_batchHook) { const h = _batchHook; _batchHook = null; h.onWin(); }
    else { _showBanner(winBanner, _nextLevel); }
  } else {
    _animateWinRetract(() => {
      if (_batchHook) { const h = _batchHook; _batchHook = null; h.onWin(); }
      else { _showBanner(winBanner, _nextLevel); }
    });
  }
}

function _onPlayerLanded(target, dx, dy, ctx) {
  const { isBoatEntry, isRetractingTowardLastCog, revisitIdx, isOneBack } = ctx;

  const gearsBeforeUpdate = state.gears.slice();
  let freedOnRevisit = -1;

  if (!isBoatEntry) {
    if (revisitIdx >= 0) {
      const freed      = state.gears.slice(revisitIdx + 1);
      freedOnRevisit   = freed.filter(g => !g.isTeleport).length; // only bend gears cost budget
      state.gears      = state.gears.slice(0, revisitIdx + 1);
      state.gearsLeft += freedOnRevisit;
    }
  } else {
    state.gearsLeft += state.gears.filter(g => !g.isTeleport).length;
    state.gears = [];
  }

  state.prevDir = isBoatEntry ? null : { dx, dy };

  if (!isBoatEntry && isRetractingTowardLastCog && revisitIdx < 0) {
    const anchor = state.gears.length > 0
      ? _gearOutPos(state.gears[state.gears.length - 1])
      : state.level.start;
    state.prevDir = {
      dx: Math.sign(state.playerPos.x - anchor.x),
      dy: Math.sign(state.playerPos.y - anchor.y),
    };
  }

  // Compute before pending-cog pop so the pop doesn't trigger a spurious retraction.
  const needsRetractAnim = !isOneBack && gearsBeforeUpdate.length > state.gears.length
                           && (isBoatEntry ? gearsBeforeUpdate.length > 0 : revisitIdx >= 0);

  // Capture retract target before pop — animation must end at the player's cell,
  // not one step past it (which would happen if the pop reduces the length first).
  const retractTarget = state.gears.length;

  // Pending-cog pop: if the player is on the last cog it hasn't committed to a new
  // bend yet — release it back to the budget regardless of how we got here.
  if (!isBoatEntry && state.gears.length > 0) {
    const last = state.gears[state.gears.length - 1];
    if (!last.isTeleport && last.x === state.playerPos.x && last.y === state.playerPos.y) {
      const prev = state.gears.length > 1
        ? _gearOutPos(state.gears[state.gears.length - 2])
        : state.level.start;
      state.gears.pop();
      state.gearsLeft++;
      state.prevDir = { dx: Math.sign(last.x - prev.x), dy: Math.sign(last.y - prev.y) };
    }
  }

  if (needsRetractAnim) {
    state.isMoving = true;
    _animateChainRetract(gearsBeforeUpdate, retractTarget, state.playerPos, state.gearsLeft, state.totalGears, state.level, () => {
      state.isMoving = false;
      setChainSpinning(false);
      drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
      _scheduleDeadEndCheck();
      _flushQueuedMove();
    }, null, state.playerPos, true, FAST_RETRACT_MS_PER_CELL);
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

// ─── teleport-aware gear helpers ─────────────────────────────────────────────

// Returns only the bend waypoints (non-teleport entries) from the gears array.
function _bendGears() { return state.gears.filter(g => !g.isTeleport); }

// The "effective outgoing position" of a gear entry: for teleport crossings
// the chain continues from the EXIT, not the entry.
function _gearOutPos(g) {
  return g.isTeleport ? { x: g.exitX, y: g.exitY } : { x: g.x, y: g.y };
}

function _chainLengthUsed() {
  // Teleport crossings contribute zero physical length: skip the entry→exit gap.
  let len = 0;
  let prevX = state.level.start.x, prevY = state.level.start.y;
  for (const g of state.gears) {
    if (g.isTeleport) {
      len += Math.abs(g.x - prevX) + Math.abs(g.y - prevY);
      prevX = g.exitX; prevY = g.exitY;
    } else {
      len += Math.abs(g.x - prevX) + Math.abs(g.y - prevY);
      prevX = g.x; prevY = g.y;
    }
  }
  len += Math.abs(state.playerPos.x - prevX) + Math.abs(state.playerPos.y - prevY);
  return len;
}

function _executeMove(dx, dy) {
  _retractToken++;
  clearTimeout(_deadEndTimer);
  _deadEndTimer = null;
  deadEndBanner.hidden = true;

  const gearSet = new Set(state.gears.filter(g => !g.isTeleport).map(g => g.y * state.level.width + g.x));

  // Call without chain limit so backtrack detection sees the natural landing position.
  // Chain length is only enforced for forward moves (after all backtrack checks below).
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

  const revisitIdx = state.gears.findIndex(g => g.x === target.x && g.y === target.y);
  const isBoatEntry = target.y < 0;

  // Detect moves that retrace the last chain segment back toward the previous anchor
  // (last gear or start).  These always shorten the chain so the cap must never block
  // them — doing so causes a softlock when chain is full and a one-way is in the way.
  // For teleport crossings, the post-teleport segment starts at the EXIT, so use
  // _gearOutPos to get the correct anchor for backward-direction detection.
  const chainAnchor = state.gears.length > 0
    ? _gearOutPos(state.gears[state.gears.length - 1])
    : state.level.start;
  const isBackwardAlongChain =
    (chainAnchor.x === state.playerPos.x && dx === 0 && dy === Math.sign(chainAnchor.y - state.playerPos.y)) ||
    (chainAnchor.y === state.playerPos.y && dy === 0 && dx === Math.sign(chainAnchor.x - state.playerPos.x));

  // Landing on an existing gear, the boat, or retracing the last segment is a backtrack —
  // chain shortens, so no cap.  Only cap genuine forward moves into new territory.
  const chainAvail = Math.max(0, state.chainLengthTotal - _chainLengthUsed());
  if (_batchBypassConstraints && _batchViolations && state.chainLengthTotal > 0 && chainAvail === 0) {
    _batchViolations.chainWasDepleted = true;
  }
  // For teleporter moves the physical chain extension is dist(playerPos→entry) + dist(exit→target),
  // not the straight Manhattan from playerPos to target (which can over- or under-estimate).
  const slideLen = target.teleportCrossing
    ? Math.abs(target.teleportCrossing.entryX - state.playerPos.x) + Math.abs(target.teleportCrossing.entryY - state.playerPos.y)
    + Math.abs(target.x - target.teleportCrossing.exitX) + Math.abs(target.y - target.teleportCrossing.exitY)
    : Math.abs(target.x - state.playerPos.x) + Math.abs(target.y - state.playerPos.y);
  const chainWouldExceed = revisitIdx < 0 && !isBoatEntry && !isBackwardAlongChain && slideLen > chainAvail;
  if (chainWouldExceed && _batchBypassConstraints) _batchViolations.chainExceeded = true;
  const moveTarget = (chainWouldExceed && !_batchBypassConstraints)
    ? slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState, gearSet, chainAvail)
    : target;
  if (moveTarget.teleportCrossing && _batchViolations) _batchViolations.teleportUsed = true;

  if (moveTarget.x === state.playerPos.x && moveTarget.y === state.playerPos.y && moveTarget.crumble === null) {
    playBlocked();
    _scheduleDeadEndCheck();
    return;
  }

  const ctx = _buildDepartureCtx(moveTarget, dx, dy);
  if (ctx === null) return;

  state.isMoving = true;
  playSlide();
  _applyPreAnimationChain(ctx, !!moveTarget.teleportCrossing);

  const moveToken = _moveToken;

  // If the slide crosses a teleporter, provide entry/exit info and a callback
  // that inserts the crossing into state.gears at the flash-out moment.
  const tc = moveTarget.teleportCrossing;
  const teleportInfo = tc ? {
    entryPos:           { x: tc.entryX, y: tc.entryY },
    exitPos:            { x: tc.exitX,  y: tc.exitY  },
    onTeleportCrossing: () => {
      // A crossing is a retrace only if it's the most recent gear — meaning no
      // subsequent gears were placed after it.  If newer gears exist, the player has
      // moved on from that crossing and this is a new forward traversal through the
      // partner teleporter, so a new crossing must be added instead of removing the old one.
      const retracedIdx = state.gears.findIndex(
        g => g.isTeleport && g.exitX === tc.entryX && g.exitY === tc.entryY
      );
      if (retracedIdx >= 0 && retracedIdx === state.gears.length - 1) {
        state.gears.splice(retracedIdx, 1);
        return true;  // retrace — caller may want to keep a visual bridge
      } else {
        state.gears.push({ isTeleport: true, x: tc.entryX, y: tc.entryY,
                           exitX: tc.exitX, exitY: tc.exitY });
        return false;
      }
    },
  } : null;

  animatePlayer(state.playerPos, moveTarget, state.level, () => {
    if (moveToken !== _moveToken) return;
    state.playerPos = { x: moveTarget.x, y: moveTarget.y };
    state.isMoving  = false;
    playLand();
    _onPlayerLanded(moveTarget, dx, dy, ctx);
  }, teleportInfo);
}
