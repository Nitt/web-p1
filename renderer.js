import { CellType, isOneway } from './puzzle.js';

// Maps ONEWAY_* CellType values → data-dir attribute strings for CSS
const ONEWAY_DIR_ATTR = {
  [CellType.ONEWAY_LEFT]:  'left',
  [CellType.ONEWAY_RIGHT]: 'right',
  [CellType.ONEWAY_UP]:    'up',
  [CellType.ONEWAY_DOWN]:  'down',
};

// ms per grid cell of travel — feel free to tune
const SPEED_MS_PER_CELL = 80;

let gridEl = null;
let playerEl = null;
let goalEl = null;
let chainSvgEl = null;
let counterSpan = null;
// Tracks the last pixel position written to the player overlay.
// Used as the authoritative animation start so there is never a
// discrepancy between the visual position and the animation origin.
let playerPx = { x: 0, y: 0 };
// Stores the last drawChain arguments so the animation loop can redraw each frame.
let _chainState = null;

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
      if (type === CellType.WALL)    cell.dataset.type = 'wall';
      if (type === CellType.STICKY)  cell.dataset.type = 'sticky';
      if (type === CellType.CRUMBLE) cell.dataset.type = 'crumble';
      if (type === CellType.KEY)     cell.dataset.type = 'key';
      if (type === CellType.DOOR)    cell.dataset.type = 'door';
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
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (steps === 0) { onDone(); return; }

  const duration = steps * SPEED_MS_PER_CELL;
  const startTime = performance.now();
  // Snap visual position to the logical start cell before reading startPx.
  // This eliminates any accumulated desync between playerPx and state.playerPos
  // (e.g. caused by a previous no-op move or mid-animation resize), so the
  // new animation always originates from exactly the right pixel.
  // The Math.max(0,…) clamp on t means this snap never causes a backward jerk.
  _placeOverlay(playerEl, from.x, from.y, level);
  const startPx = { ...playerPx };

  function frame(now) {
    const t = Math.max(0, Math.min((now - startTime) / duration, 1));
    // End position is recalculated every frame so mid-animation resizes stay correct.
    const endPx = _cellPixel(to.x, to.y, level);
    const cx = startPx.x + (endPx.x - startPx.x) * t;
    const cy = startPx.y + (endPx.y - startPx.y) * t;
    _setOverlayPixel(playerEl, cx, cy);
    if (_chainState) _redrawChain(cx, cy);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      onDone();
    }
  }
  requestAnimationFrame(frame);
}

/**
 * Re-place both overlays at their current logical positions.
 * Call this after a layout change (e.g. window resize).
 */
export function repositionOverlays(playerPos, level) {
  _placeOverlay(playerEl, playerPos.x, playerPos.y, level);
  _placeOverlay(goalEl,   level.goal.x, level.goal.y, level);
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
  _chainState = { gears, gearsLeft, totalGears, level };
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

function _redrawChain(px, py) {
  if (!chainSvgEl || !gridEl || !_chainState) return;
  const { gears, gearsLeft, level } = _chainState;
  chainSvgEl.innerHTML = '';

  const gridRect = gridEl.getBoundingClientRect();
  const W = gridRect.width;
  const H = gridRect.height;
  chainSvgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // Build the list of points: start cell → each gear → current player pixel
  const points = [
    _cellPixel(level.start.x, level.start.y, level),
    ...gears.map(g => _cellPixel(g.x, g.y, level)),
    { x: px, y: py },
  ];

  if (points.length < 2) return;

  const NS = 'http://www.w3.org/2000/svg';

  // Rope polyline
  const polyline = document.createElementNS(NS, 'polyline');
  polyline.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'rgba(60,80,120,0.55)');
  polyline.setAttribute('stroke-width', '2.5');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');
  chainSvgEl.appendChild(polyline);

  // Gear shapes at each waypoint (skip start and player positions)
  for (let i = 1; i < points.length - 1; i++) {
    const g = document.createElementNS(NS, 'path');
    g.setAttribute('d', _gearPath(points[i].x, points[i].y, 18, 12, 8));
    g.setAttribute('fill', 'rgba(50,70,110,0.75)');
    g.setAttribute('stroke', 'rgba(255,255,255,0.4)');
    g.setAttribute('stroke-width', '0.8');
    chainSvgEl.appendChild(g);

    // Hole in the center
    const hole = document.createElementNS(NS, 'circle');
    hole.setAttribute('cx', points[i].x);
    hole.setAttribute('cy', points[i].y);
    hole.setAttribute('r', '5');
    hole.setAttribute('fill', 'rgba(255,255,255,0.5)');
    chainSvgEl.appendChild(hole);
  }

  // Update the counter span inside the player div
  if (counterSpan) counterSpan.textContent = gearsLeft;
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

function _setOverlayPixel(el, cx, cy) {
  if (el === playerEl) playerPx = { x: cx, y: cy };
  el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
}
