import { slidePlayer } from './puzzle.js';
import { buildGrid, placePlayer, animatePlayer, repositionOverlays } from './renderer.js';
import { initInput } from './input.js';
import { generateLevel } from './generator.js';
import { SAMPLE_LEVELS } from './levels.js';

// ─── DOM refs (set in init) ───────────────────────────────────────────────────
let gridContainer = null;
let dpadEl       = null;
let winBanner    = null;
let levelLabel   = null;

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
  nextSeed:    100,    // seed for the next generated level
};

// ─── entry point ─────────────────────────────────────────────────────────────
export function init() {
  gridContainer = document.getElementById('grid-container');
  dpadEl        = document.getElementById('dpad');
  winBanner     = document.getElementById('win-banner');
  levelLabel    = document.getElementById('level-label');

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

  if (levelLabel) levelLabel.textContent = `Level ${level.id}`;
  winBanner.hidden = true;

  buildGrid(gridContainer, level);
  placePlayer(state.playerPos, level);
}

function _nextLevel() {
  const level = generateLevel(9, 9, { seed: state.nextSeed, id: state.nextId });
  state.nextSeed += 1;
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
  const target = slidePlayer(state.level, state.playerPos, dx, dy);
  if (target.x === state.playerPos.x && target.y === state.playerPos.y) return;

  state.isMoving = true;

  animatePlayer(state.playerPos, target, state.level, () => {
    state.playerPos = target;
    state.isMoving  = false;

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

    // Flush queued move if it arrived within the time window.
    const q = state.queuedMove;
    state.queuedMove = null;
    if (q && (performance.now() - q.queuedAt) <= QUEUE_WINDOW_MS) {
      _executeMove(q.dx, q.dy);
    }
  });
}
