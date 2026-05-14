import { slidePlayer, buildToggleMap, canReachGoal, canReachAnyOf, CellType, onewayAllows } from './puzzle.js';
import { solve } from './solver.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays, drawChain, drawChainWithPixelTail, getCellPixel, setChainSpinning, setTailGearSpinning, removeCrumble, removeKey, openDoor, getSpeedMultiplier, setChainLengthTotal, setGoalFollowsPlayer } from './renderer.js';
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
  _autoPlaying = false;
  _batchHook   = null;
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
  const waypoints = [];
  if (tailStartOverride) waypoints.push(tailStartOverride);
  for (let i = fromGears.length - 1; i >= targetLength; i--) waypoints.push(fromGears[i]);
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
        // Pending-cog pop: the player just landed on the last gear — it hasn't
        // committed to a new bend yet, so release it (mirrors _onPlayerLanded).
        if (gearIdx >= 0 && state.gears.length > 0) {
          const last = state.gears[state.gears.length - 1];
          if (last.x === state.playerPos.x && last.y === state.playerPos.y) {
            const prev = state.gears.length > 1 ? state.gears[state.gears.length - 2] : state.level.start;
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

/** Return the level object currently being played. */
export function getCurrentLevel() {
  return state.level;
}

/** Start auto-playing a solution to the current level. */
export function autoPlay() {
  if (_autoPlaying || state.won) return;
  const moves = solve(state.level, state.playerPos, state.worldState, state.toggleMap, state.chainLengthTotal);
  if (!moves) {
    _logPlaythroughFailure(state.level, state.levelIndex, 'solver found no path', []);
    return;
  }
  _autoPlaying = true;
  _batchHook = {
    onWin:   ()  => _showBanner(winBanner, _nextLevel),
    onStuck: r   => {
      _logPlaythroughFailure(state.level, state.levelIndex, r, moves);
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
 * Play through the first `count` levels with full animations, automatically
 * advancing on win and logging detailed info on any failure.
 * Levels are generated with the same seed/recipe sequence as the game.
 */
export async function runBatchPlaythrough(count = 50) {
  console.group(`Batch playthrough: levels 1–${count}`);
  let failures = 0;

  // Pre-generate level sequence using the same seed progression as the game.
  const levelSeq = [SAMPLE_LEVELS[0]];
  let seed = 300, id = 2, levelIdx = 2, sinceKeyDoor = 0;
  for (let n = 2; n <= count; n++) {
    const recipe = getRecipe(levelIdx, sinceKeyDoor);
    const level  = generateFallback(seed, id, recipe);
    levelSeq.push(level);
    sinceKeyDoor = level.doorRequirements?.size > 0 ? 0 : sinceKeyDoor + 1;
    seed += recipe.candidates;
    id++; levelIdx++;
  }

  for (let i = 0; i < levelSeq.length; i++) {
    const displayNum = i + 1;

    // Load the level and wait for the initial auto-slide to finish.
    const prevCount = _levelLoadCount;
    loadLevel(levelSeq[i]);
    await _waitForNewLevel(prevCount);

    const level = state.level;
    const moves = solve(level, state.playerPos, state.worldState, state.toggleMap, state.chainLengthTotal);

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

    if (outcome === 'won') {
      console.log(`Level ${displayNum}: ✓`);
    } else {
      failures++;
      _logPlaythroughFailure(level, displayNum, outcome, moves);
    }
  }

  if (failures === 0) {
    console.log(`All ${count} levels solved ✓`);
  } else {
    console.warn(`${failures}/${count} failed — see groups above`);
  }
  console.groupEnd();
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

function _logPlaythroughFailure(level, displayNum, reason, plannedMoves) {
  const goalDepth  = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x] : 0;
  const gearBudget = (level.effectiveCogs ?? goalDepth) > 0
    ? (level.effectiveCogs ?? goalDepth) : 1;
  const ARROW = { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' };

  console.group(`%cLevel ${displayNum} — ${reason}`, 'color:#e05; font-weight:bold');
  console.log('%c[AI] Paste this entire console group into Claude. Before answering, read CLAUDE.md at the project root — it explains the chain/gear system, solver limitations, and how to interpret each field below.', 'color:#888;font-style:italic');
  console.log('Seed:', level.seed, '  Size:', `${level.width}×${level.height}`);
  console.log('Start:', level.start, '  Goal:', level.goal);
  console.log('Chain limit:', state.chainLengthTotal, '  Gear budget:', gearBudget);
  console.log('Player stopped at:', { ...state.playerPos },
              '  World state:', state.worldState.toString(2).padStart(8, '0'));
  console.log('Chain used:', _chainLengthUsed(), '/', state.chainLengthTotal,
              '  Gears left:', state.gearsLeft, '/', state.totalGears);
  if (plannedMoves?.length) {
    console.log('Planned moves:',
      plannedMoves.map(m => ARROW[`${m.dx},${m.dy}`] ?? `(${m.dx},${m.dy})`).join(' '));
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
      ? Array.from(level.doorRequirements.entries()) : [],
  }, null, 2));
  console.groupEnd();
}

/** Render a level's grid as a readable ASCII string. */
function _renderGrid(level) {
  const SYM  = ['.', '#', 'S', '←', '→', '↑', '↓', 'c', 'K', 'D'];
  const { width, height, cells, start, goal } = level;
  const lines = [];
  for (let y = 0; y < height; y++) {
    let row = '';
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
  if (idx >= moves.length) {
    // All moves dispatched — wait for the last animation to settle before
    // deciding outcome. _handleWin sets state.won asynchronously via animation
    // callbacks, so we must not call onStuck while a slide is still in flight.
    if (state.isMoving) { setTimeout(() => _autoPlayNext(moves, idx), 50); return; }
    // Animation done and no win — solver/game divergence (chain length mismatch?).
    _autoPlaying = false;
    if (_batchHook) {
      const h = _batchHook; _batchHook = null;
      h.onStuck('solver path exhausted without reaching goal (chain mismatch?)');
    }
    return;
  }
  if (state.isMoving) { setTimeout(() => _autoPlayNext(moves, idx), 50); return; }
  handleMove(moves[idx].dx, moves[idx].dy);
  setTimeout(() => _autoPlayNext(moves, idx + 1), 50);
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

  // 0 gears → simple V, skip placement.
  // 1 gear  → pop it and retract cleanly instead of creating a V.
  // 2+ gears → real loop; place the gear normally.
  const isBoatVShapeRetract = isBoatEntry && isBend && !isAtLastCog && state.gears.length === 1;

  if (willUseGear && state.gearsLeft === 0) { _scheduleDeadEndCheck(); return null; }
  if (isBoatEntry && isBend && !isAtLastCog && state.gears.length >= 2 && state.gearsLeft === 0) { _scheduleDeadEndCheck(); return null; }
  if (state.gearsLeft === 0 && revisitIdx >= 0 && revisitIdx < state.gears.length - 2) { _scheduleDeadEndCheck(); return null; }

  const pendingBendGear    = isBend && !isAtLastCog && !isBoatEntry && revisitIdx >= 0;
  const effectiveGearCount = state.gears.length + (pendingBendGear ? 1 : 0);
  const isOneBack = (!isBoatEntry && revisitIdx >= 0 && revisitIdx === effectiveGearCount - 2)
                 || (isBoatEntry && state.gears.length === 1);

  return { isBoatEntry, isStraightThrough, isBend, isRetractingTowardLastCog,
           revisitIdx, isAtLastCog, isOneBack, pendingBendGear, isBoatVShapeRetract };
}

// Draws the pre-animation chain state and pushes the departure cog if turning.
function _applyPreAnimationChain(ctx) {
  const { isBoatEntry, isBend, isAtLastCog, isOneBack, revisitIdx, pendingBendGear, isBoatVShapeRetract } = ctx;
  if (isOneBack && !pendingBendGear) {
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

function _animateWinRetract(onDone) {
  const gearsSnapshot = state.gears.slice();
  // Walk back: goal → each gear in reverse → start (boat entry)
  const waypoints = [...gearsSnapshot.slice().reverse(), state.level.start];
  let displayGears = gearsSnapshot.slice();

  setChainSpinning(true, -1);
  setGoalFollowsPlayer(true);

  function step(waypointIdx, fromPos) {
    // Drop the gear the player just left (skip on the first step — fromPos is the goal, not a gear)
    if (waypointIdx > 0 && displayGears.length > 0) {
      displayGears = displayGears.slice(0, displayGears.length - 1);
    }
    drawChain(displayGears, fromPos, state.gearsLeft, state.totalGears, state.level);

    const toPos = waypoints[waypointIdx];
    animatePlayer(fromPos, toPos, state.level, () => {
      if (waypointIdx === waypoints.length - 1) {
        setChainSpinning(false);
        setGoalFollowsPlayer(false);
        onDone();
      } else {
        step(waypointIdx + 1, toPos);
      }
    });
  }

  step(0, state.playerPos);
}

function _handleWin() {
  state.won = true;
  playWin();
  state.queuedMove = null;
  _animateWinRetract(() => {
    if (_batchHook) {
      const h = _batchHook; _batchHook = null; h.onWin();
    } else {
      _showBanner(winBanner, _nextLevel);
    }
  });
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

  // Capture retract target before pop — animation must end at the player's cell,
  // not one step past it (which would happen if the pop reduces the length first).
  const retractTarget = state.gears.length;

  // Pending-cog pop: if the player is on the last cog it hasn't committed to a new
  // bend yet — release it back to the budget regardless of how we got here.
  if (!isBoatEntry && state.gears.length > 0) {
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

function _chainLengthUsed() {
  const chain = [state.level.start, ...state.gears, state.playerPos];
  let len = 0;
  for (let i = 1; i < chain.length; i++) {
    len += Math.abs(chain[i].x - chain[i-1].x) + Math.abs(chain[i].y - chain[i-1].y);
  }
  return len;
}

function _executeMove(dx, dy) {
  _retractToken++;
  clearTimeout(_deadEndTimer);
  _deadEndTimer = null;
  deadEndBanner.hidden = true;

  const gearSet = new Set(state.gears.map(g => g.y * state.level.width + g.x));

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
  const chainAnchor = state.gears.length > 0 ? state.gears[state.gears.length - 1] : state.level.start;
  const isBackwardAlongChain =
    (chainAnchor.x === state.playerPos.x && dx === 0 && dy === Math.sign(chainAnchor.y - state.playerPos.y)) ||
    (chainAnchor.y === state.playerPos.y && dy === 0 && dx === Math.sign(chainAnchor.x - state.playerPos.x));

  // Landing on an existing gear, the boat, or retracing the last segment is a backtrack —
  // chain shortens, so no cap.  Only cap genuine forward moves into new territory.
  const chainAvail = Math.max(0, state.chainLengthTotal - _chainLengthUsed());
  const slideLen   = Math.abs(target.x - state.playerPos.x) + Math.abs(target.y - state.playerPos.y);
  const moveTarget = (revisitIdx < 0 && !isBoatEntry && !isBackwardAlongChain && slideLen > chainAvail)
    ? slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState, gearSet, chainAvail)
    : target;

  if (moveTarget.x === state.playerPos.x && moveTarget.y === state.playerPos.y && moveTarget.crumble === null) {
    playBlocked();
    _scheduleDeadEndCheck();
    return;
  }

  const ctx = _buildDepartureCtx(moveTarget, dx, dy);
  if (ctx === null) return;

  state.isMoving = true;
  playSlide();
  _applyPreAnimationChain(ctx);

  const moveToken = _moveToken;
  animatePlayer(state.playerPos, moveTarget, state.level, () => {
    if (moveToken !== _moveToken) return;
    state.playerPos = { x: moveTarget.x, y: moveTarget.y };
    state.isMoving  = false;
    playLand();
    _onPlayerLanded(moveTarget, dx, dy, ctx);
  });
}
