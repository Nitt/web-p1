import { slidePlayer, buildToggleMap, canReachGoal } from './puzzle.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays, drawChain, drawChainWithPixelTail, getCellPixel, setChainSpinning, removeCrumble, removeKey, openDoor } from './renderer.js';
import { initInput } from './input.js';
import { generateHardestLevel } from './generator.js';
import { SAMPLE_LEVELS } from './levels.js';
import { getRecipe } from './levelConfig.js';

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

// ─── background level pre-generation ─────────────────────────────────────────
const _worker = new Worker(new URL('./levelWorker.js', import.meta.url), { type: 'module' });
_worker.onerror = (e) => console.error('[game] worker error:', e.message, e);
let _pendingLevel  = null;   // Promise → level object when worker finishes
let _pendingRecipe = null;   // recipe used for the pending pre-generation

function _pregenNext(seed, id, recipe) {
  _pendingRecipe = recipe;
  _pendingLevel = new Promise(resolve => {
    _worker.onmessage = ({ data }) => resolve(data);
  });
  _worker.postMessage({
    width: 9, height: 9, seed, id,
    candidates:       recipe.candidates,
    weights:          recipe.weights,
    useKeyDoor:       recipe.useKeyDoor,
    difficultyTarget: recipe.difficultyTarget,
  });
}

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
  gears:                [],     // [{x,y}] ordered waypoint positions visited so far
  gearsLeft:            0,      // remaining gear budget
  totalGears:           0,      // starting budget (used for display/scoring)
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
  state.level       = level;
  state.playerPos   = { ...level.start };
  state.isMoving    = false;
  state.won         = false;
  state.queuedMove  = null;
  state.worldState  = 0;
  state.toggleMap   = buildToggleMap(level.cells);
  state.pendingOnewayBreak = null;

  // Gear budget: exactly the minimum solution depth.
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
  _pregenNext(state.nextSeed, state.nextId, nextRecipe);

  // Auto-slide the diver down from the surface into the water.
  _executeMove(0, 1);
}

function _nextLevel() {
  const seed = state.nextSeed;
  const id   = state.nextId;
  state.nextSeed += _pendingRecipe?.candidates ?? 300;
  state.nextId   += 1;

  // Update progression counters before loading so loadLevel's pre-gen is accurate.
  state.levelIndex += 1;
  const hadKeyDoor = state.level?.doorRequirements?.size > 0;
  state.levelsSinceKeyDoor = hadKeyDoor ? 0 : state.levelsSinceKeyDoor + 1;

  // Use the pre-generated level if ready; otherwise generate synchronously with
  // a reduced candidate count to avoid blocking the main thread too long.
  Promise.resolve(_pendingLevel).then(level => {
    if (!level) {
      const recipe = getRecipe(id, state.levelsSinceKeyDoor);
      level = generateHardestLevel(9, 9, { seed, id, ...recipe, candidates: 20 });
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
// Total animation time is capped at TOTAL_MS regardless of segment count.
let _retractToken = 0;
function _animateChainRetract(fromGears, targetLength, playerPos, gearsLeft, totalGears, level, onDone) {
  const TOTAL_MS    = 100;
  const numSegments = fromGears.length - targetLength;
  const segmentMs   = TOTAL_MS / numSegments;
  const token = ++_retractToken;
  let gears = fromGears.slice();

  function animateSegment() {
    if (token !== _retractToken) { onDone(); return; }
    if (gears.length <= targetLength) {
      drawChain(gears, playerPos, gearsLeft, totalGears, level);
      onDone();
      return;
    }

    const tailIdx  = gears.length - 1;
    const prevIdx  = tailIdx - 1;
    const fromPx   = getCellPixel(gears[tailIdx].x, gears[tailIdx].y, level);
    const toPx     = prevIdx >= 0
      ? getCellPixel(gears[prevIdx].x, gears[prevIdx].y, level)
      : getCellPixel(playerPos.x, playerPos.y, level);
    const duration = segmentMs;
    const startTime = performance.now();
    const gearsWithoutTail = gears.slice(0, tailIdx);

    function frame(now) {
      if (token !== _retractToken) { onDone(); return; }
      const t  = Math.min((now - startTime) / duration, 1);
      const cx = fromPx.x + (toPx.x - fromPx.x) * t;
      const cy = fromPx.y + (toPx.y - fromPx.y) * t;
      drawChainWithPixelTail(gearsWithoutTail, { x: cx, y: cy }, gearsLeft, totalGears, level);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        gears = gearsWithoutTail;
        animateSegment();
      }
    }
    requestAnimationFrame(frame);
  }

  animateSegment();
}

function _scheduleDeadEndCheck() {
  // Skip the check if the player is in the boat (y < 0) — always reachable from there.
  if (state.playerPos.y < 0) return;
  if (!canReachGoal(state.level, state.playerPos, state.worldState, state.toggleMap)) {
    _deadEndTimer = setTimeout(() => {
      if (!state.won) {
        deadEndBanner.hidden = false;
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
 * Returns the index in state.gears of the last gear that is on the "entry side"
 * of the one-way at (owx, owy) when approaching in direction (dx, dy).
 * Entry side: (g.x - owx)*dx + (g.y - owy)*dy < 0
 */
function _findOnewayEntryGear(owx, owy, dx, dy) {
  for (let i = state.gears.length - 1; i >= 0; i--) {
    const g = state.gears[i];
    if ((g.x - owx) * dx + (g.y - owy) * dy < 0) return i;
  }
  return -1;
}

/**
 * Animate the player to state.gears[gearIdx] and shorten the chain back to it.
 * Mirrors the revisit path in _executeMove.
 */
function _executeBacktrack(gearIdx) {
  const backtrackPos = state.gears[gearIdx];

  const isOneBack = gearIdx === state.gears.length - 2;
  if (isOneBack) {
    drawChain(
      state.gears.slice(0, gearIdx + 1),
      state.playerPos, state.gearsLeft + 1, state.totalGears, state.level,
    );
  }

  state.isMoving = true;
  setChainSpinning(true, -1);

  animatePlayer(state.playerPos, backtrackPos, state.level, () => {
    state.playerPos = { x: backtrackPos.x, y: backtrackPos.y };
    state.isMoving  = false;

    const gearsBeforeUpdate = state.gears.slice();
    const freed = state.gears.length - gearIdx - 1;
    state.gears     = state.gears.slice(0, gearIdx + 1);
    state.gearsLeft += freed;

    const needsRetractAnim = !isOneBack && gearsBeforeUpdate.length > state.gears.length;
    if (needsRetractAnim) {
      state.isMoving = true;
      _animateChainRetract(gearsBeforeUpdate, state.gears.length, state.playerPos, state.gearsLeft, state.totalGears, state.level, () => {
        state.isMoving = false;
        setChainSpinning(false);
        _scheduleDeadEndCheck();
        _flushQueuedMove();
      });
    } else {
      drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
      setChainSpinning(false);
      _scheduleDeadEndCheck();
      _flushQueuedMove();
    }
  });
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

function _executeMove(dx, dy) {
  _retractToken++; // cancel any in-progress retraction animation
  // Cancel any pending dead-end popup when a new move starts.
  clearTimeout(_deadEndTimer);
  _deadEndTimer = null;
  deadEndBanner.hidden = true;
  const gearSet = new Set(state.gears.map(g => g.y * state.level.width + g.x));
  const target = slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState, gearSet);
  const didMove    = target.x !== state.playerPos.x || target.y !== state.playerPos.y;
  const hasCrumble = target.crumble !== null;
  if (!didMove && !hasCrumble) {
    if (target.blockedByOneway) {
      const { x: owx, y: owy } = target.blockedByOneway;
      const p = state.pendingOnewayBreak;
      if (p && p.dx === dx && p.dy === dy && p.owx === owx && p.owy === owy) {
        // Second press into the same blocked one-way — backtrack to last entry-side gear.
        state.pendingOnewayBreak = null;
        const entryIdx = _findOnewayEntryGear(owx, owy, dx, dy);
        if (entryIdx >= 0) _executeBacktrack(entryIdx);
      } else {
        state.pendingOnewayBreak = { dx, dy, owx, owy };
      }
    } else {
      state.pendingOnewayBreak = null;
    }
    return;
  }
  state.pendingOnewayBreak = null;

  // Moving into the boat (above the grid) is a free move — no gear consumed.
  const isBoatEntry = target.y < 0;

  // ── Gear check ────────────────────────────────────────────────────────────
  // Determine if landing on an already-visited waypoint (revisit = chain shortens,
  // no new gear consumed) or on a fresh cell (requires a free gear).
  const revisitIdx = isBoatEntry ? -2 : state.gears.findIndex(g => g.x === target.x && g.y === target.y);
  const willUseGear = !isBoatEntry && revisitIdx < 0;
  if (willUseGear && state.gearsLeft === 0) return;  // silently blocked — no gears left
  // With 0 gears, only the immediately previous cog can be revisited (not older ones).
  if (state.gearsLeft === 0 && revisitIdx >= 0 && revisitIdx < state.gears.length - 2) return;

  state.isMoving = true;

  // ── Pre-animation chain update for "one back" retraction ─────────────────
  // When moving into the cog immediately behind the latest one, shorten the
  // chain state before the animation so the retraction is visible during movement.
  const isOneBack = (!isBoatEntry && revisitIdx >= 0 && revisitIdx === state.gears.length - 2)
                 || (isBoatEntry && state.gears.length === 1);
  if (isOneBack) {
    drawChain(
      state.gears.slice(0, revisitIdx + 1),
      state.playerPos, state.gearsLeft + 1, state.totalGears, state.level,
    );
  }

  setChainSpinning(true, willUseGear ? 1 : -1);
  animatePlayer(state.playerPos, target, state.level, () => {
    state.playerPos = { x: target.x, y: target.y };
    state.isMoving  = false;

    // ── Update gear chain ────────────────────────────────────────────────────
    const gearsBeforeUpdate = state.gears.slice();
    if (!isBoatEntry) {
      if (revisitIdx >= 0) {
        // Revisited a past waypoint — shorten chain back to it, reclaim gears.
        const freed = state.gears.length - revisitIdx - 1;
        state.gears = state.gears.slice(0, revisitIdx + 1);
        state.gearsLeft += freed;
      } else {
        state.gears.push({ x: target.x, y: target.y });
        state.gearsLeft--;
      }
    } else {
      // Returned to the boat — retract the full chain, reclaim all gears.
      state.gearsLeft += state.gears.length;
      state.gears = [];
    }

    // Animate retraction for multi-back revisit or boat entry (when chain is non-empty).
    const needsRetractAnim = !isOneBack && gearsBeforeUpdate.length > state.gears.length
                             && (isBoatEntry ? gearsBeforeUpdate.length > 0 : revisitIdx >= 0);
    if (needsRetractAnim) {
      state.isMoving = true; // keep blocked during retraction
      _animateChainRetract(gearsBeforeUpdate, state.gears.length, state.playerPos, state.gearsLeft, state.totalGears, state.level, () => {
        state.isMoving = false;
        setChainSpinning(false);
        _scheduleDeadEndCheck();
        _flushQueuedMove();
      });
    } else {
      drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);
    }

    // Activate the crumble toggle: set its bit in worldState and update the DOM.
    if (hasCrumble) {
      const { x: cx, y: cy, toggleIdx } = target.crumble;
      if (toggleIdx !== undefined) {
        state.worldState |= (1 << toggleIdx);
      }
      removeCrumble(cx, cy, state.level);
    }

    // Key collected: activate its toggle, animate removal, and open paired doors.
    if (target.keyCollected) {
      const { x: kx, y: ky, toggleIdx } = target.keyCollected;
      if (toggleIdx !== undefined) {
        state.worldState |= (1 << toggleIdx);
        if (state.level.doorRequirements) {
          for (const [flatIdx, reqToggle] of state.level.doorRequirements) {
            if (reqToggle === toggleIdx) {
              openDoor(flatIdx % state.level.width, Math.floor(flatIdx / state.level.width), state.level);
            }
          }
        }
      }
      removeKey(kx, ky, state.level);
    }

    if (
      target.x === state.level.goal.x &&
      target.y === state.level.goal.y
    ) {
      state.won = true;
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
      return;
    }

    // Flush queued move if it arrived within the time window.
    // (needsRetractAnim defers this until after the retraction animation.)
    if (!needsRetractAnim) {
      setChainSpinning(false);
      _scheduleDeadEndCheck();
      _flushQueuedMove();
    }
  });
}
