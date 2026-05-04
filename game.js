import { slidePlayer, buildToggleMap } from './puzzle.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays, drawChain, removeCrumble, removeKey, openDoor } from './renderer.js';
import { initInput } from './input.js';
import { generateHardestLevel } from './generator.js';
import { SAMPLE_LEVELS } from './levels.js';
import { getRecipe } from './levelConfig.js';

// ─── DOM refs (set in init) ───────────────────────────────────────────────────
let gridContainer    = null;
let dpadEl           = null;
let winBanner        = null;
let levelLabel       = null;

// How many ms before animation end an input is still considered "on time".
// Inputs queued earlier than this window will be discarded.
const QUEUE_WINDOW_MS = 300;

// ─── background level pre-generation ─────────────────────────────────────────
const _worker = new Worker(new URL('./levelWorker.js', import.meta.url), { type: 'module' });
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
};

// ─── entry point ─────────────────────────────────────────────────────────────
export function init() {
  gridContainer  = document.getElementById('grid-container');
  dpadEl         = document.getElementById('dpad');
  winBanner      = document.getElementById('win-banner');
  levelLabel     = document.getElementById('level-label');

  document.getElementById('restart-btn')
    .addEventListener('click', () => loadLevel(state.level));

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

  // Gear budget: 25% above the minimum solution depth (easy to tune).
  const goalDepth = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x]
    : 0;
  const budget = Math.ceil((goalDepth > 0 ? goalDepth : 1) * 1.25);
  state.gears      = [];
  state.gearsLeft  = budget;
  state.totalGears = budget;

  if (levelLabel) levelLabel.textContent = `Level ${level.id}`;
  winBanner.hidden = true;

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

  // Use the pre-generated level if ready; otherwise generate synchronously.
  Promise.resolve(_pendingLevel).then(level => {
    if (!level) {
      const recipe = getRecipe(id, state.levelsSinceKeyDoor);
      level = generateHardestLevel(9, 9, { seed, id, ...recipe });
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

function _executeMove(dx, dy) {
  const gearSet = new Set(state.gears.map(g => g.y * state.level.width + g.x));
  const target = slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState, gearSet);
  const didMove    = target.x !== state.playerPos.x || target.y !== state.playerPos.y;
  const hasCrumble = target.crumble !== null;
  if (!didMove && !hasCrumble) return;

  // Moving into the boat (above the grid) is a free move — no gear consumed.
  const isBoatEntry = target.y < 0;

  // ── Gear check ────────────────────────────────────────────────────────────
  // Determine if landing on an already-visited waypoint (revisit = chain shortens,
  // no new gear consumed) or on a fresh cell (requires a free gear).
  const revisitIdx = isBoatEntry ? -2 : state.gears.findIndex(g => g.x === target.x && g.y === target.y);
  const willUseGear = !isBoatEntry && revisitIdx < 0;
  if (willUseGear && state.gearsLeft === 0) return;  // silently blocked — no gears left

  state.isMoving = true;

  animatePlayer(state.playerPos, target, state.level, () => {
    state.playerPos = { x: target.x, y: target.y };
    state.isMoving  = false;

    // ── Update gear chain ────────────────────────────────────────────────────
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
    drawChain(state.gears, state.playerPos, state.gearsLeft, state.totalGears, state.level);

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
    const q = state.queuedMove;
    state.queuedMove = null;
    if (q && (performance.now() - q.queuedAt) <= QUEUE_WINDOW_MS) {
      _executeMove(q.dx, q.dy);
    }
  });
}
