import { slidePlayer, buildToggleMap, CellType, onewayAllows } from './puzzle.js';
import { makeRng } from './random.js';
import { buildGrid, placePlayer, animatePlayer, animateChainJerkInPlace, repositionOverlays, drawChain, drawChainWithPixelTail, getCellPixel, setChainSpinning, setTailGearSpinning, removeCrumble, removeKey, openDoor, getSpeedMultiplier, setSpeedMultiplier, setGoalFollowsPlayer, showDiveIndicator, hideDiveIndicator, showDiveHint, showMoveHint, hideMoveHint } from './renderer.js';
import { initInput } from './input.js';
import { pregenNext, takePendingLevel, getPendingRecipe, generateFallback } from './progression.js';
import { SAMPLE_LEVELS } from './levels.js';
import { getRecipe } from './levelConfig.js';
import { playSlide, playLand, playBlocked, playCrumble, playKeyCollect, playDoorOpen, playWin } from './sounds.js';
import { solve } from './solver.js';

// ─── DOM refs (set in init) ───────────────────────────────────────────────────
let gridContainer    = null;
let dpadEl           = null;
let winBanner        = null;
let levelLabel       = null;

// Tracks whether the dive hint was triggered for this level.
let _diveHintShown = false;
// Inactivity timer that shows the move hint after the player dives without further input.
let _moveHintTimer = null;


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
  peakGearsUsed:        0,      // highest (totalGears - gearsLeft) seen this level (recorded at key)
  prevDir:              null,   // {dx, dy} of last completed move, for bend detection
  // Parallel-universe / world-state system.
  worldState:           0,
  toggleMap:            null,
  // Progression tracking.
  levelIndex:           1,      // 1-indexed number of the level currently being played
  levelsSinceKeyDoor:   0,      // levels elapsed since last key/door level appeared
  // One-way double-press backtrack.
  pendingOnewayBreak:   null,   // { dx, dy, owx, owy } — set after first blocked-by-oneway press
  // True while the player is in the boat waiting to dive; cleared on first downward move.
  waitingForDive:       false,
};

// ─── auto-solver ──────────────────────────────────────────────────────────────
let _autoMoveQueue         = [];
let _autoSolving           = false;
let _autoSolveUsedBacktrack = false; // true when phase 3 / hint-backtrack was needed
let _autoPhaseCallback  = null;   // called instead of failure when queue empties mid-solve
let _solverStartPos     = null;   // player pos when solver was invoked
let _solverStartGears   = 0;      // gearsLeft when solver was invoked
let _solverInitialMoves = [];     // full move list returned by solver
let _solverMoveIdx      = 0;      // moves dispatched so far this run

// ─── batch / ∞ test ───────────────────────────────────────────────────────────
// When running, chain and gear limits are tracked but not enforced so the
// solver can win even when budgets are slightly wrong.  Failures auto-advance
// to the next level; wins skip the banner and advance immediately.
let _batchRunning = false;
let _batchTotal   = 0;
let _batchFails   = 0;

// Matches DIRS4 ordering in solver.js: RIGHT=0, LEFT=1, DOWN=2, UP=3, none=4.
function _prevDirToIndex(prevDir) {
  if (!prevDir)          return 4;
  if (prevDir.dx ===  1) return 0;
  if (prevDir.dx === -1) return 1;
  if (prevDir.dy ===  1) return 2;
  return 3;
}

function _moveArrow({ dx, dy }) {
  return dx === 1 ? '→' : dx === -1 ? '←' : dy === 1 ? '↓' : '↑';
}

function _renderLevelGrid() {
  const { level, playerPos, gears, worldState, toggleMap } = state;
  const { width, height, goal } = level;
  const GLYPHS = ['.', '#', 'S', '←', '→', '↑', '↓', 'c', 'K', 'D', 'T'];

  const gearNums = new Map();
  gears.filter(g => !g.isTeleport).forEach((g, i) => gearNums.set(g.y * width + g.x, (i + 1) % 10));

  const colHdr  = '       ' + Array.from({ length: width }, (_, x) => x % 10).join(' ');
  const divider = '       ' + '-'.repeat(width * 2 - 1);
  const lines   = [colHdr, divider];

  for (let y = 0; y < height; y++) {
    let row = `y=${String(y).padStart(2)} | `;
    for (let x = 0; x < width; x++) {
      if (x > 0) row += ' ';
      const flat = y * width + x;
      if (x === playerPos.x && y === playerPos.y) {
        row += '@';
      } else if (x === goal.x && y === goal.y) {
        row += 'G';
      } else if (gearNums.has(flat)) {
        row += gearNums.get(flat);
      } else {
        const ct = level.cells[flat];
        const ti = toggleMap?.get(flat);
        if (ti !== undefined && ((worldState >> ti) & 1)) {
          row += '.';  // crumble broken or key collected
        } else if (ct === 9 && level.doorRequirements) {
          const reqTi = level.doorRequirements.get(flat);
          row += (reqTi !== undefined && ((worldState >> reqTi) & 1)) ? 'd' : 'D';
        } else {
          row += GLYPHS[ct] ?? '?';
        }
      }
    }
    lines.push(row);
  }
  return lines.join('\n');
}

function _logAutoSolveFailure(reason) {
  const { level, playerPos, gears, worldState, gearsLeft, totalGears, prevDir } = state;
  const bendGears  = gears.filter(g => !g.isTeleport);
  const executed   = _solverInitialMoves.slice(0, _solverMoveIdx);
  const remaining  = _solverInitialMoves.slice(_solverMoveIdx);

  const features = [];
  if (level.toggleMap?.size)        features.push(`${level.toggleMap.size} crumble/key toggles`);
  if (level.doorRequirements?.size) features.push(`${level.doorRequirements.size} door(s)`);
  if (level.teleporterMap?.size)    features.push('teleporters');

  console.group(`%cLevel ${level.id} — ${reason}`, 'color:#e04060;font-weight:bold');
  console.log(`Size: ${level.width}×${level.height}  |  seed: ${level.seed ?? '?'}  |  features: ${features.join(', ') || 'none'}`);
  console.log(`Boat entry (y=-1): (${level.start.x}, -1)`);
  if (_solverStartPos) console.log(`Solver started at: (${_solverStartPos.x}, ${_solverStartPos.y})  |  gearsLeft: ${_solverStartGears}`);
  console.log(`Gear budget: ${totalGears}`);
  console.log(`Player stopped at: (${playerPos.x}, ${playerPos.y})  |  prevDir: ${prevDir ? _moveArrow(prevDir) : 'none'}`);
  console.log(`World state: ${worldState.toString(2).padStart(8, '0')}`);
  console.log(`Gears left / total: ${gearsLeft} / ${totalGears}`);
  console.log(`Gear waypoints: ${bendGears.length ? bendGears.map(g => `(${g.x},${g.y})`).join(' → ') : '(none)'}`);
  if (_solverInitialMoves.length > 0) {
    console.log(`Planned moves (${_solverInitialMoves.length}): ${_solverInitialMoves.map(_moveArrow).join(' ')}`);
    if (_solverMoveIdx > 0)        console.log(`  executed (${executed.length}):  ${executed.map(_moveArrow).join(' ')}`);
    if (remaining.length > 0)      console.log(`  remaining (${remaining.length}): ${remaining.map(_moveArrow).join(' ')}`);
  }
  if (level.doorRequirements?.size) {
    const pairs = [...level.doorRequirements.entries()].map(([flatIdx, ti]) => {
      const dx = flatIdx % level.width, dy = Math.floor(flatIdx / level.width);
      return `door(${dx},${dy})↔toggle${ti}`;
    });
    console.log(`Door requirements: ${pairs.join('  ')}`);
  }
  console.log('Grid:\n' + _renderLevelGrid());
  const levelJSON = JSON.parse(JSON.stringify(level, (k, v) => {
    if (v instanceof Uint8Array)  return Array.from(v);
    if (v instanceof Map)         return Object.fromEntries([...v.entries()]);
    return v;
  }));
  console.log('Level JSON:', levelJSON);
  console.groupEnd();

  if (_batchRunning) {
    _batchTotal++;
    _batchFails++;
    // Defer so any _cancelAutoSolve() after this call finishes first.
    setTimeout(() => _batchAdvanceLevel(), 0);
  }
}

function _cancelAutoSolve() {
  _autoSolving           = false;
  _autoSolveUsedBacktrack = false;
  _autoMoveQueue         = [];
  _autoPhaseCallback     = null;
  document.getElementById('auto-solve-btn')?.classList.remove('active');
}

function _dispatchNextAutoMove() {
  if (!_autoSolving || _autoMoveQueue.length === 0) {
    if (_autoSolving && !state.won) {
      if (_autoPhaseCallback) {
        const cb = _autoPhaseCallback;
        _autoPhaseCallback = null;
        cb();
        return;
      }
      _logAutoSolveFailure('solver path exhausted without reaching goal (chain mismatch?)');
    }
    _cancelAutoSolve();
    return;
  }
  _solverMoveIdx++;
  const { dx, dy } = _autoMoveQueue.shift();
  if (state.waitingForDive) {
    if (dy === 1) { state.waitingForDive = false; hideDiveIndicator(); }
    else          { _cancelAutoSolve(); return; }
  }
  _executeMove(dx, dy);
}

function _autoSolve() {
  if (_autoSolving) { _cancelAutoSolve(); return; }
  if (state.won || state.isMoving) return;

  _autoPhaseCallback = null;
  _solverStartPos   = { ...state.playerPos };
  _solverStartGears = state.gearsLeft;

  // ── Run Dijkstra from the current player position ─────────────────────────
  const result = solve(
    state.level, state.playerPos, state.worldState,
    state.gearsLeft, _prevDirToIndex(state.prevDir)
  );

  const btn = document.getElementById('auto-solve-btn');
  if (result && result.moves.length > 0) {
    _solverInitialMoves = [...result.moves];
    _solverMoveIdx      = 0;
    _autoSolving        = true;
    _autoMoveQueue      = [...result.moves];
    btn?.classList.add('active');
    _dispatchNextAutoMove();
    return;
  }

  // No direct path — for key+door levels try navigating to the goal first (in case
  // there's a route without the key), then fall back to key-first.
  if (state.level.doorRequirements?.size > 0 && _findUncollectedKeyCell()) {
    _tryKeyFirstStrategy();
    return;
  }

  btn?.classList.add('no-path');
  setTimeout(() => btn?.classList.remove('no-path'), 500);
  _solverInitialMoves = [];
  _solverMoveIdx      = 0;
  _logAutoSolveFailure('solver found no path');
}

// Returns the position of the first uncollected KEY cell, or null.
function _findUncollectedKeyCell() {
  const { cells, width } = state.level;
  for (let flat = 0; flat < cells.length; flat++) {
    if (cells[flat] === CellType.KEY) {
      const ti = state.toggleMap?.get(flat);
      if (ti === undefined || !(state.worldState & (1 << ti))) {
        return { x: flat % width, y: Math.floor(flat / width) };
      }
    }
  }
  return null;
}

// Direction index (0–3, or 4=none) the player would have after backtracking to gears[gearIdx].
function _prevDiAtGearIdx(gearIdx) {
  if (gearIdx < 0) return 4;
  const g        = state.gears[gearIdx];
  const prevGear = gearIdx > 0 ? state.gears[gearIdx - 1] : null;
  const prev     = prevGear
    ? (prevGear.isTeleport ? { x: prevGear.exitX, y: prevGear.exitY } : prevGear)
    : state.level.start;
  const dx = Math.sign(g.x - prev.x), dy = Math.sign(g.y - prev.y);
  if (dx ===  1) return 0;
  if (dx === -1) return 1;
  if (dy ===  1) return 2;
  if (dy === -1) return 3;
  return 4;
}

// Phase 1: try goal directly first; if that fails, navigate to the key.
function _tryKeyFirstStrategy() {
  const keyCell = _findUncollectedKeyCell();
  // Try goal directly from current position (ignoring door, in case there's a path around it).
  const goalOnly = { ...state.level, doorRequirements: null };
  const directResult = solve(goalOnly, state.playerPos, state.worldState,
    state.gearsLeft, _prevDirToIndex(state.prevDir));

  if (directResult && directResult.moves.length > 0) {
    _solverInitialMoves = [...directResult.moves];
    _solverMoveIdx      = 0;
    _autoSolving        = true;
    _autoMoveQueue      = [...directResult.moves];
    document.getElementById('auto-solve-btn')?.classList.add('active');
    _dispatchNextAutoMove();
    return;
  }

  const keyLevel  = { ...state.level, goal: keyCell };
  const keyResult = solve(keyLevel, state.playerPos, state.worldState,
    state.gearsLeft, _prevDirToIndex(state.prevDir));

  if (!keyResult || keyResult.moves.length === 0) {
    console.log('[auto-solve] phase 1 — cannot reach key either, giving up');
    const btn = document.getElementById('auto-solve-btn');
    btn?.classList.add('no-path');
    setTimeout(() => btn?.classList.remove('no-path'), 500);
    _solverInitialMoves = [];
    _solverMoveIdx      = 0;
    _logAutoSolveFailure('solver found no path');
    return;
  }

  _solverInitialMoves = [...keyResult.moves];
  _solverMoveIdx      = 0;
  _autoSolving        = true;
  _autoMoveQueue      = [...keyResult.moves];
  _autoPhaseCallback  = _planGoalAfterKey;
  document.getElementById('auto-solve-btn')?.classList.add('active');
  _dispatchNextAutoMove();
}

// Phase 2: key collected — try to solve to goal; if stuck, try backtracking through gears.
function _planGoalAfterKey() {
  const result = solve(state.level, state.playerPos, state.worldState,
    state.gearsLeft, _prevDirToIndex(state.prevDir));

  if (result && result.moves.length > 0) {
    _solverInitialMoves = [...result.moves];
    _solverMoveIdx      = 0;
    _autoMoveQueue      = [...result.moves];
    _dispatchNextAutoMove();
    return;
  }

  _tryBacktrackForGoal();
}

// Phase 3: can't reach goal from current position after collecting key — walk back through
// each gear waypoint (in reverse) until we find one from which the goal is reachable,
// then animate the backtrack and execute the solution.
function _tryBacktrackForGoal() {
  const gears = state.gears;

  for (let i = gears.length - 1; i >= -1; i--) {
    if (i >= 0 && gears[i].isTeleport) continue;

    const pos = i < 0 ? state.level.start : { x: gears[i].x, y: gears[i].y };
    // Backtracking to gears[i] frees gears[i..N-1] (via _executeBacktrack) plus the
    // pending-pop of gears[i] itself, so total freed = gears.slice(i) non-teleport count.
    const gearsFreed = gears.slice(Math.max(0, i)).filter(g => !g.isTeleport).length;
    const gearsAvail = state.gearsLeft + gearsFreed;

    const result = solve(state.level, pos, state.worldState,
      gearsAvail, _prevDiAtGearIdx(i));

    if (result && result.moves.length > 0) {
      _autoSolveUsedBacktrack = true;
      const goalMoves = [...result.moves];
      _autoPhaseCallback = () => {
        _solverInitialMoves = [...goalMoves];
        _solverMoveIdx      = 0;
        _autoMoveQueue      = [...goalMoves];
        _autoPhaseCallback  = null;
        _dispatchNextAutoMove();
      };
      _executeBacktrack(i);
      return;
    }
  }

  console.log('[auto-solve] phase 3 — all backtrack positions exhausted, no path found');
  _logAutoSolveFailure('solver found no path (key+door: cannot reach goal after backtracking through all gears)');
  _cancelAutoSolve();
}

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
    effectiveCogs: 3,
  };
}

// ─── entry point ─────────────────────────────────────────────────────────────
export function init() {
  gridContainer  = document.getElementById('grid-container');
  dpadEl         = document.getElementById('dpad');
  winBanner      = document.getElementById('win-banner');
  levelLabel     = document.getElementById('level-label');

  document.getElementById('restart-btn')
    .addEventListener('click', () => loadLevel(state.level));

  document.getElementById('auto-solve-btn')
    .addEventListener('click', _autoSolve);

  // Backtick (`) skips to the next level — debug/testing shortcut.
  document.addEventListener('keydown', e => {
    if (e.key === '`') skipLevel();
  });

  initInput(gridContainer, dpadEl, handleMove, () => {
    if (state.waitingForDive) { _diveHintShown = true; showDiveHint(); }
  });

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
  // Cancel any in-flight player or retraction animations from the previous level.
  _moveToken++;
  _retractToken++;
  _cancelAutoSolve();
  state.level       = level;
  state.playerPos   = { ...level.start };
  state.isMoving    = false;
  state.won         = false;
  state.queuedMove  = null;
  state.worldState  = 0;
  state.toggleMap   = buildToggleMap(level.cells);
  state.pendingOnewayBreak = null;
  state.prevDir     = null;

  const goalDepth = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x]
    : 0;
  const budget = (level.effectiveCogs ?? goalDepth) > 0 ? (level.effectiveCogs ?? goalDepth) : 1;
  state.gears         = [];
  state.gearsLeft     = budget;
  state.totalGears    = budget;
  state.peakGearsUsed = 0;

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

  buildGrid(gridContainer, level);
  placePlayer(state.playerPos, level);
  drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, level);

  // Kick off background generation of the next level immediately.
  const nextRecipe = getRecipe(state.nextId, state.levelsSinceKeyDoor);
  pregenNext(state.nextSeed, state.nextId, nextRecipe);

  // Show the dive indicator and wait for the player to manually dive in.
  state.waitingForDive = true;
  _diveHintShown = false;
  if (_moveHintTimer) { clearTimeout(_moveHintTimer); _moveHintTimer = null; }
  hideMoveHint();
  showDiveIndicator(level);
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
  if (_autoSolving) _cancelAutoSolve();
  if (state.won) return;

  // Cancel the post-dive inactivity timer and dismiss the move hint on any input.
  if (_moveHintTimer) { clearTimeout(_moveHintTimer); _moveHintTimer = null; }
  hideMoveHint();
  if (state.waitingForDive) {
    if (dy === 1) {
      // Player is diving in — clear the waiting state and proceed normally.
      state.waitingForDive = false;
      hideDiveIndicator();
    } else {
      // Any non-down input while in the boat: show a hint and eat the input.
      _diveHintShown = true;
      showDiveHint();
      return;
    }
  }

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
  if (_batchRunning) { onDone(); return; }
  const token = ++_retractToken;

  // Build ordered waypoints: tailStart → fromGears[last] → … → tailEnd.
  // Teleport crossings contribute two waypoints each: exit side (where the tail
  // arrives coming from the far end) then entry side (where it re-emerges),
  // with the bridge crossing treated as an instant jump (0 grid-cell distance).
  // segKeepCounts[i] = how many fromGears to show while the tail is in segment i.
  const waypoints     = [];
  const segKeepCounts = [];
  if (tailStartOverride) {
    waypoints.push(tailStartOverride);
    segKeepCounts.push(fromGears.length);
  }
  for (let i = fromGears.length - 1; i >= targetLength; i--) {
    const g = fromGears[i];
    if (g.isTeleport) {
      waypoints.push({ x: g.exitX, y: g.exitY });          // tail reaches exit side
      segKeepCounts.push(i + 1);                            // T still shown
      waypoints.push({ x: g.x, y: g.y, _tpJump: true });  // instant jump to entry
      segKeepCounts.push(i);                                // T dropped
    } else {
      waypoints.push(g);
      segKeepCounts.push(i);
    }
  }
  waypoints.push(tailEndOverride ?? (targetLength > 0 ? fromGears[targetLength - 1] : playerPos));
  segKeepCounts.push(targetLength);

  // Pixel coords and cumulative grid-cell distances along the waypoint path.
  // _tpJump waypoints use 0 distance so the bridge crossing is instantaneous.
  const wPx = waypoints.map(w => getCellPixel(w.x, w.y, level));
  const cumDist = [0];
  for (let i = 1; i < waypoints.length; i++) {
    const d = waypoints[i]._tpJump ? 0 : (Math.max(
      Math.abs(waypoints[i].x - waypoints[i - 1].x),
      Math.abs(waypoints[i].y - waypoints[i - 1].y),
    ) || 1);
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

    // Gears to render: exclude gears the tail has already passed.
    const keepCount = segKeepCounts[seg];
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
        _flushQueuedMove();
      } else {
        step(waypointIdx + 1, toPos);
      }
    });
  }

  if (_batchRunning) {
    state.playerPos = { x: backtrackPos.x, y: backtrackPos.y };
    state.isMoving  = false;
    if (gearIdx < 0) state.prevDir = null;
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
    setChainSpinning(false);
    _flushQueuedMove();
  } else {
    step(0, state.playerPos);
  }
}

/** Skip to the next level (debug/test shortcut). */
export function skipLevel() {
  _nextLevel();
}

/**
 * Advance to the next level and immediately auto-solve it (batch mode only).
 * Mirrors _nextLevel() but inlines the async load so we can run _autoSolve()
 * right after loadLevel() while _batchRunning is still true.
 */
function _batchAdvanceLevel() {
  if (!_batchRunning) return;

  const seed = state.nextSeed;
  const id   = state.nextId;
  state.nextSeed += getPendingRecipe()?.candidates ?? 300;
  state.nextId   += 1;
  state.levelIndex += 1;
  const hadKeyDoor = state.level?.doorRequirements?.size > 0;
  state.levelsSinceKeyDoor = hadKeyDoor ? 0 : state.levelsSinceKeyDoor + 1;

  Promise.resolve(takePendingLevel()).then(level => {
    if (!_batchRunning) return;
    if (!level) {
      const recipe = getRecipe(id, state.levelsSinceKeyDoor);
      level = generateFallback(seed, id, recipe);
    }
    loadLevel(level);
    _autoSolve();
  });
}

/**
 * Start (or stop) the ∞ batch test.
 * Runs _autoSolve() on every level from the current one onward.
 * Failures are logged in full; clean passes print only "✓ Level N".
 * Chain and gear limits are tracked but not enforced so a budget mismatch
 * doesn't block the solver from winning.
 */
export function startBatchTest() {
  if (_batchRunning) {
    _batchRunning = false;
    _cancelAutoSolve();
    document.getElementById('batch-test-btn')?.classList.remove('active');
    console.log(`[batch] stopped — ${_batchTotal} levels, ${_batchFails} failures`);
    return;
  }

  _batchRunning = true;
  _batchTotal   = 0;
  _batchFails   = 0;
  document.getElementById('batch-test-btn')?.classList.add('active');
  console.log(`[batch] started from level ${state.level?.id ?? '?'}`);
  _autoSolve();
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
    return;
  }
  if (_autoSolving) _dispatchNextAutoMove();
}

function _playBlockedWithJerk(dx, dy) {
  playBlocked();
  animateChainJerkInPlace(state.playerPos, { dx, dy }, state.level);
  if (_autoSolving) {
    _logAutoSolveFailure(`move blocked during auto-play (tried ${_moveArrow({ dx, dy })} — move ${_solverMoveIdx} of ${_solverInitialMoves.length})`);
    _cancelAutoSolve();
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

  // Detect early so we can skip the straight-through pop — the chain will be
  // fully retracted in _onPlayerLanded anyway, and popping a gear here causes
  // wrong isBend/prevDir on the following move.
  const isReturnToStart = !isBoatEntry && !!target.teleportCrossing
    && target.x === state.playerPos.x && target.y === state.playerPos.y;

  // Snapshot prevDir before any state mutation so _onPlayerLanded can restore it.
  const savedPrevDir = state.prevDir;

  let isStraightThrough = false;
  if (!isBoatEntry && !isReturnToStart && state.gears.length > 0) {
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
    if (!_batchRunning) return null;
  }
  if (isBoatEntry && isBend && !isAtLastCog && bendGearCount >= 2 && state.gearsLeft === 0) {
    if (!_batchRunning) return null;
  }
  if (state.gearsLeft === 0 && revisitIdx >= 0 && revisitIdx < state.gears.length - 2) {
    if (!_batchRunning) return null;
  }

  const pendingBendGear    = isBend && !isAtLastCog && !isBoatEntry && revisitIdx >= 0;
  const effectiveGearCount = state.gears.length + (pendingBendGear ? 1 : 0);
  const isOneBack = (!isBoatEntry && revisitIdx >= 0 && revisitIdx === effectiveGearCount - 2)
                 || (isBoatEntry && _bendGears().length === 1);

  return { isBoatEntry, isStraightThrough, isBend, isRetractingTowardLastCog,
           revisitIdx, isAtLastCog, isOneBack, pendingBendGear, isBoatVShapeRetract,
           isReturnToStart, savedPrevDir };
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
    state.peakGearsUsed = Math.max(state.peakGearsUsed, state.totalGears - state.gearsLeft);
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
  const wasAutoSolving   = _autoSolving;
  const usedBacktrack    = _autoSolveUsedBacktrack;
  _cancelAutoSolve();
  state.won = true;
  playWin();
  state.queuedMove = null;

  const gearsUsed   = state.totalGears - state.gearsLeft;
  const peakGears   = Math.max(gearsUsed, state.peakGearsUsed);
  const gearOptimal = peakGears === state.totalGears;
  if (_batchRunning) {
    _batchTotal++;
    if (gearOptimal) {
      console.log(`✓ Level ${state.level.id}`);
    } else {
      const gearsLeft2 = state.totalGears - peakGears;
      console.warn(
        `Level ${state.level.id} — budget mismatch: ` +
        `gears ${peakGears}/${state.totalGears}${gearOptimal ? ' ✓' : ` (${gearsLeft2} left)`}`
      );
    }
    _batchAdvanceLevel();
    return;
  }

  if (wasAutoSolving) {
    console.log(`[auto-solve] ✓${usedBacktrack ? ' (used backtracking)' : ''}`);
  } else {
    console.log(
      `Level ${state.level.id} — ` +
      `gears: ${peakGears}/${state.totalGears} ${gearOptimal ? '✓' : `(${state.totalGears - peakGears} left)`}`
    );
  }

  _animateWinRetract(() => {
    _showBanner(winBanner, _nextLevel);
  });
}

function _onPlayerLanded(target, dx, dy, ctx) {
  const { isBoatEntry, isRetractingTowardLastCog, revisitIdx, isOneBack, isBend, isAtLastCog, isReturnToStart, savedPrevDir } = ctx;

  const gearsBeforeUpdate = state.gears.slice();
  let freedOnRevisit = -1;

  if (isReturnToStart) {
    // Teleporter routed the slide back to the starting cell.
    // Remove the teleport crossing (added during animation) and the bend gear at
    // playerPos (added by _applyPreAnimationChain for this move, if any), then
    // animate the chain retracting back.
    if (state.gears.length > 0 && state.gears[state.gears.length - 1].isTeleport) {
      state.gears.pop();
    }
    if (isBend && !isAtLastCog && state.gears.length > 0) {
      const last = state.gears[state.gears.length - 1];
      if (!last.isTeleport && last.x === state.playerPos.x && last.y === state.playerPos.y) {
        state.gears.pop();
        state.gearsLeft++;
      }
    }
    state.prevDir = savedPrevDir; // restore — this was a no-op move, next move should see unchanged prevDir
    const retractTarget = state.gears.length;
    state.isMoving = true;
    _animateChainRetract(gearsBeforeUpdate, retractTarget, state.playerPos, state.gearsLeft, state.totalGears, state.level, () => {
      state.isMoving = false;
      setChainSpinning(false);
      drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
      _flushQueuedMove();
    }, null, state.playerPos, true, FAST_RETRACT_MS_PER_CELL);
    _applyCollectibles(target);
    return;
  }

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


function _executeMove(dx, dy) {
  _retractToken++;

  const gearSet = new Set(state.gears.filter(g => !g.isTeleport).map(g => g.y * state.level.width + g.x));
  // Treat the player's current position as an implicit stop — a teleporter could
  // route the slide back here, and the bend gear (placed later in _applyPreAnimationChain)
  // won't be in gearSet yet.
  gearSet.add(state.playerPos.y * state.level.width + state.playerPos.x);

  const target = slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState, gearSet);
  const didMove    = target.x !== state.playerPos.x || target.y !== state.playerPos.y;
  const hasCrumble = target.crumble !== null;

  if (_tryOnewayBacktrack(target, dx, dy, didMove)) return;

  if (!didMove && !hasCrumble && !target.teleportCrossing) {
    state.pendingOnewayBreak = null;
    _playBlockedWithJerk(dx, dy);
    return;
  }
  state.pendingOnewayBreak = null;

  const revisitIdx = state.gears.findIndex(g => g.x === target.x && g.y === target.y);
  const ctx = _buildDepartureCtx(target, dx, dy);
  if (ctx === null) { _playBlockedWithJerk(dx, dy); return; }

  state.isMoving = true;
  playSlide();
  _applyPreAnimationChain(ctx, !!target.teleportCrossing);

  const moveToken = _moveToken;

  // If the slide crosses a teleporter, provide entry/exit info and a callback
  // that inserts the crossing into state.gears at the flash-out moment.
  const tc = target.teleportCrossing;
  const teleportInfo = tc ? {
    entryPos:           { x: tc.entryX, y: tc.entryY },
    exitPos:            { x: tc.exitX,  y: tc.exitY  },
    onTeleportCrossing: () => {
      // A crossing is a retrace only if it's the most recent gear — meaning no
      // subsequent gears were placed after it.  If newer gears exist, the player has
      // moved on from that crossing and this is a new forward traversal through the
      // partner teleporter, so a new crossing must be added instead of removing the old one.
      const retracedIdx = state.gears.findLastIndex(
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

  const _comingFromBoat = state.playerPos.y < 0;

  if (_batchRunning) {
    if (teleportInfo) teleportInfo.onTeleportCrossing();
    state.playerPos = { x: target.x, y: target.y };
    state.isMoving  = false;
    _onPlayerLanded(target, dx, dy, ctx);
  } else {
    animatePlayer(state.playerPos, target, state.level, () => {
      if (moveToken !== _moveToken) return;
      state.playerPos = { x: target.x, y: target.y };
      state.isMoving  = false;
      playLand();
      _onPlayerLanded(target, dx, dy, ctx);
      if (_comingFromBoat && _diveHintShown) {
        _moveHintTimer = setTimeout(showMoveHint, 3500);
      }
    }, teleportInfo, !tc ? { dx, dy } : null);
  }
}
