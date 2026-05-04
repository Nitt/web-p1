import { slidePlayer, buildToggleMap } from './puzzle.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays, explodePlayer, removeCrumble, removeKey, openDoor } from './renderer.js';
import { initInput } from './input.js';
import { generateHardestLevel } from './generator.js';
import { SAMPLE_LEVELS } from './levels.js';

// ─── DOM refs (set in init) ───────────────────────────────────────────────────
let gridContainer    = null;
let dpadEl           = null;
let winBanner        = null;
let levelLabel       = null;
let movesCounterEl   = null;

// How many ms before animation end an input is still considered "on time".
// Inputs queued earlier than this window will be discarded.
const QUEUE_WINDOW_MS = 300;

// ─── game state ───────────────────────────────────────────────────────────────
const state = {
  level:       null,
  playerPos:   null,
  isMoving:    false,
  won:         false,
  queuedMove:  null,   // { dx, dy, queuedAt } — next move buffered during animation
  nextId:      2,      // id for the next generated level
  nextSeed:    300,    // seed for the next generated level (0–299 used by level 1)
  movesLeft:   0,      // decrements each move; explosion + reset at 0
  // Parallel-universe / world-state system.
  // Each topological change (crumble break, door open, …) is a "toggle".
  // worldState is a bitmask: bit N set means toggle N is active.
  // toggleMap maps flat cell index → toggle index (built once per level).
  worldState:  0,
  toggleMap:   null,
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

  const goalDepth = level.depths
    ? level.depths[level.goal.y * level.width + level.goal.x]
    : 0;
  state.movesLeft = goalDepth > 0 ? goalDepth : 0;

  if (levelLabel) levelLabel.textContent = `Level ${level.id}`;
  winBanner.hidden = true;

  buildGrid(gridContainer, level);
  movesCounterEl = gridContainer.querySelector('.player-moves');
  _updateMovesDisplay();
  placePlayer(state.playerPos, level);
}

function _nextLevel() {
  const CANDIDATES = 300;
  const level = generateHardestLevel(9, 9, { seed: state.nextSeed, id: state.nextId, candidates: CANDIDATES });
  state.nextSeed += CANDIDATES;
  state.nextId   += 1;
  loadLevel(level);
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
  const target = slidePlayer(state.level, state.playerPos, dx, dy, state.toggleMap, state.worldState);
  const didMove    = target.x !== state.playerPos.x || target.y !== state.playerPos.y;
  const hasCrumble = target.crumble !== null;
  if (!didMove && !hasCrumble) return;

  state.isMoving = true;

  animatePlayer(state.playerPos, target, state.level, () => {
    state.playerPos = { x: target.x, y: target.y };
    state.isMoving  = false;

    // Activate the crumble toggle: set its bit in worldState and update the DOM.
    // The level.cells array is NOT mutated — the world-state bitmask is the
    // authoritative record of which crumbles (and future toggles) are broken.
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
        // Open every door that requires this toggle.
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
      setTimeout(_nextLevel, 1200);
      return;
    }

    // Decrement moves counter.
    if (state.movesLeft > 0) {
      state.movesLeft--;
      _updateMovesDisplay();
    }

    if (state.movesLeft === 0) {
      // Out of moves — block input, explode, then reset.
      state.isMoving   = true;
      state.queuedMove = null;
      explodePlayer(() => loadLevel(state.level));
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

function _updateMovesDisplay() {
  if (!movesCounterEl) return;
  movesCounterEl.textContent = state.movesLeft;
  const playerEl = movesCounterEl.closest('.player');
  if (playerEl) playerEl.classList.toggle('low', state.movesLeft > 0 && state.movesLeft <= 3);
}
