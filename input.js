// Minimum pixel distance for a swipe to register
const SWIPE_THRESHOLD = 30;

const DIRS = [
  { dx: 0,  dy: -1, key: 'up'    },
  { dx: 0,  dy:  1, key: 'down'  },
  { dx: -1, dy:  0, key: 'left'  },
  { dx:  1, dy:  0, key: 'right' },
];

/**
 * Wire up all input sources (keyboard, touch, d-pad buttons).
 *
 * @param {HTMLElement} swipeTarget  - element to listen for touch events on
 * @param {HTMLElement} dpadEl       - container holding the four d-pad buttons
 * @param {(dx:number, dy:number) => void} onMove
 */
export function initInput(swipeTarget, dpadEl, onMove) {
  _initKeyboard(onMove);
  _initSwipe(swipeTarget, onMove);
  _initMouseDrag(onMove);
  _initDpad(dpadEl, onMove);
}

// ─── keyboard ────────────────────────────────────────────────────────────────

const KEY_MAP = {
  ArrowUp:    { dx:  0, dy: -1 },
  ArrowDown:  { dx:  0, dy:  1 },
  ArrowLeft:  { dx: -1, dy:  0 },
  ArrowRight: { dx:  1, dy:  0 },
  w: { dx:  0, dy: -1 },
  s: { dx:  0, dy:  1 },
  a: { dx: -1, dy:  0 },
  d: { dx:  1, dy:  0 },
  W: { dx:  0, dy: -1 },
  S: { dx:  0, dy:  1 },
  A: { dx: -1, dy:  0 },
  D: { dx:  1, dy:  0 },
};

function _initKeyboard(onMove) {
  window.addEventListener('keydown', e => {
    const dir = KEY_MAP[e.key];
    if (!dir) return;
    e.preventDefault();
    onMove(dir.dx, dir.dy);
  });
}

// ─── touch swipe ─────────────────────────────────────────────────────────────

function _initSwipe(el, onMove) {
  let startX = 0;
  let startY = 0;

  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const dist = Math.max(adx, ady);
    if (dist < SWIPE_THRESHOLD) return;
    if (adx >= ady) {
      onMove(dx > 0 ? 1 : -1, 0);
    } else {
      onMove(0, dy > 0 ? 1 : -1);
    }
  }, { passive: true });
}

// ─── mouse drag ──────────────────────────────────────────────────────────────

function _initMouseDrag(onMove) {
  let startX = 0;
  let startY = 0;
  let dragging = false;

  document.addEventListener('mousedown', e => {
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
  });

  document.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const dist = Math.max(adx, ady);
    if (dist < SWIPE_THRESHOLD) return;
    if (adx >= ady) {
      onMove(dx > 0 ? 1 : -1, 0);
    } else {
      onMove(0, dy > 0 ? 1 : -1);
    }
  });

  // Cancel drag if mouse leaves the window
  document.addEventListener('mouseleave', () => { dragging = false; });
}

// ─── d-pad ───────────────────────────────────────────────────────────────────

function _initDpad(dpadEl, onMove) {
  for (const dir of DIRS) {
    const btn = dpadEl.querySelector(`[data-dir="${dir.key}"]`);
    if (!btn) continue;
    btn.addEventListener('click', () => onMove(dir.dx, dir.dy));
    // touchstart so the response doesn't wait for the 300ms tap delay
    btn.addEventListener('touchstart', e => {
      e.preventDefault();
      onMove(dir.dx, dir.dy);
    }, { passive: false });
  }
}
