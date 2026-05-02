import { CellType } from './puzzle.js';

// ms per grid cell of travel — feel free to tune
const SPEED_MS_PER_CELL = 80;

let gridEl = null;
let playerEl = null;
let goalEl = null;

/**
 * Build (or rebuild) the grid DOM from a level.
 * @param {HTMLElement} container
 * @param {object} level
 */
export function buildGrid(container, level) {
  container.innerHTML = '';
  container.style.setProperty('--cols', level.width);
  container.style.setProperty('--rows', level.height);

  gridEl = document.createElement('div');
  gridEl.className = 'grid';
  container.appendChild(gridEl);

  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const type = level.cells[y * level.width + x];
      if (type === CellType.WALL) cell.dataset.type = 'wall';
      gridEl.appendChild(cell);
    }
  }

  // Goal marker (overlay)
  goalEl = document.createElement('div');
  goalEl.className = 'goal';
  gridEl.appendChild(goalEl);
  _placeOverlay(goalEl, level.goal.x, level.goal.y, level);

  // Player (overlay)
  playerEl = document.createElement('div');
  playerEl.className = 'player';
  gridEl.appendChild(playerEl);
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
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) { onDone(); return; }

  const duration = steps * SPEED_MS_PER_CELL;
  const startPx = _cellPixel(from.x, from.y, level);
  const endPx   = _cellPixel(to.x,   to.y,   level);
  const startTime = performance.now();

  function frame(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const cx = startPx.x + (endPx.x - startPx.x) * t;
    const cy = startPx.y + (endPx.y - startPx.y) * t;
    _setOverlayPixel(playerEl, cx, cy);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      onDone();
    }
  }
  requestAnimationFrame(frame);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function _cellPixel(x, y, level) {
  const rect = gridEl.getBoundingClientRect();
  const cellW = rect.width  / level.width;
  const cellH = rect.height / level.height;
  return {
    x: x * cellW + cellW / 2,
    y: y * cellH + cellH / 2,
  };
}

function _placeOverlay(el, x, y, level) {
  const px = _cellPixel(x, y, level);
  _setOverlayPixel(el, px.x, px.y);
}

function _setOverlayPixel(el, cx, cy) {
  el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
}
