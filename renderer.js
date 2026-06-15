import { CellType } from './puzzle.js';

// ── constants ─────────────────────────────────────────────────────────────────
const TILE      = 16;   // canvas pixels per grid cell
const BOAT_ROWS = 2;    // extra canvas rows above the grid (sky + waterline)
const SPEED_BASE = 80;  // ms per cell at 1× speed
const FLASH_MS   = 180; // teleport flash duration (scaled by speedMult)

// chain colour stops (distance in cells from player end)
const CHAIN_STOPS = [
  { upTo: 2,        r: 196, g: 164, b: 147 },
  { upTo: 6,        r: 186, g: 167, b: 63  },
  { upTo: 12,       r: 170,  g: 143, b: 64  },
  { upTo: Infinity, r: 140,  g: 123,  b: 130 },
];

const LINK_LINE = 4;   // px of thin connector between links
const LINK_RECT = 5;   // px of link rectangle (equal to LINK_LINE)
const LINK_TOT  = LINK_LINE + LINK_RECT;   // 10 px period
const LINK_LEAN = 5;   // px offset from gear centre to the correct side

// ── speed ─────────────────────────────────────────────────────────────────────
let _speedMult = 1;
export function setSpeedMultiplier(m) { _speedMult = Math.max(0.1, m); }
export function getSpeedMultiplier()  { return _speedMult; }

// ── interface stubs (not needed in pixel renderer) ────────────────────────────
export function setChainSpinning()    {}
export function setTailGearSpinning() {}
export function toggleWaveDebug()     {}

// ── canvas / level state ──────────────────────────────────────────────────────
let _canvas       = null;
let _ctx          = null;
let _level        = null;
let _containerEl  = null;
let _gearHeartsEl = null;
let _t0           = 0;
let _rafHandle    = null;

// ── chain ─────────────────────────────────────────────────────────────────────
let _chainGears  = [];
let _chainTailPx = null;   // null → use live _playerPx
let _gearsLeft   = 0;
let _totalGears  = 0;

// ── player ────────────────────────────────────────────────────────────────────
let _playerPx      = { x: 0, y: 0 };
let _playerOpacity = 1;
let _animToken     = 0;
let _playerAnim    = null;
// _playerAnim shapes:
//   { type:'slide',    from, to, startTime, dur, onDone }
//   { type:'teleport', phase:'slide1'|'flash'|'slide2',
//     slide1From, entryPx, exitPx, slide2To,
//     slide1Dur, slide2Dur, startTime, flashStart,
//     onTeleportCrossing, flashJumped, onDone }

let _jerkState      = null;  // { endPx, dx, dy, startTime }
let _jerkAvatarOnly = false;
export function setJerkAvatarOnly(v) { _jerkAvatarOnly = v; }

let _goalFollowsPlayer = false;
export function setGoalFollowsPlayer(v) { _goalFollowsPlayer = v; }

// ── crumble animations ────────────────────────────────────────────────────────
const _crumbles = new Map();   // `${x},${y}` → startTime (ms)

// ── explode animation ─────────────────────────────────────────────────────────
let _explodeAnim = null;  // { startPx, startTime, onDone }

// ── DOM overlays ──────────────────────────────────────────────────────────────
let _diveIndicatorEl = null;
let _moveHintEl      = null;

// ─────────────────────────────────────────────────────────────────────────────
// RAF loop
// ─────────────────────────────────────────────────────────────────────────────

function _startLoop() {
  if (_rafHandle) return;
  _t0 = performance.now();
  _rafHandle = requestAnimationFrame(_loop);
}

function _loop(now) {
  _rafHandle = requestAnimationFrame(_loop);
  if (!_canvas || !_ctx || !_level) return;
  _tick(now);
  _render(now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation tick  — advances _playerPx / _playerOpacity each frame
// ─────────────────────────────────────────────────────────────────────────────

function _tick(now) {
  if (!_playerAnim) return;
  const anim = _playerAnim;

  if (anim.type === 'slide') {
    const t = anim.dur > 0 ? Math.min((now - anim.startTime) / anim.dur, 1) : 1;
    _playerPx = {
      x: anim.from.x + (anim.to.x - anim.from.x) * t,
      y: anim.from.y + (anim.to.y - anim.from.y) * t,
    };
    if (t >= 1) {
      _playerPx  = { ...anim.to };
      _playerAnim = null;
      anim.onDone();
    }
    return;
  }

  if (anim.type === 'teleport') {
    if (anim.phase === 'slide1') {
      const t = anim.slide1Dur > 0
        ? Math.min((now - anim.startTime) / anim.slide1Dur, 1) : 1;
      _playerPx = {
        x: anim.slide1From.x + (anim.entryPx.x - anim.slide1From.x) * t,
        y: anim.slide1From.y + (anim.entryPx.y - anim.slide1From.y) * t,
      };
      if (t >= 1) {
        _playerPx   = { ...anim.entryPx };
        anim.phase      = 'flash';
        anim.flashStart = now;
        anim.flashJumped = false;
      }

    } else if (anim.phase === 'flash') {
      const ft = Math.min((now - anim.flashStart) / (FLASH_MS * _speedMult), 1);
      if (ft < 0.5) {
        _playerOpacity = 1 - ft * 2;
        _playerPx = { ...anim.entryPx };
      } else {
        if (!anim.flashJumped) {
          anim.flashJumped = true;
          anim.onTeleportCrossing?.();
        }
        _playerOpacity = (ft - 0.5) * 2;
        _playerPx = { ...anim.exitPx };
      }
      if (ft >= 1) {
        _playerOpacity    = 1;
        anim.phase        = 'slide2';
        anim.slide2Start  = now;
        anim.slide2FromPx = { ...anim.exitPx };
      }

    } else if (anim.phase === 'slide2') {
      const t = anim.slide2Dur > 0
        ? Math.min((now - anim.slide2Start) / anim.slide2Dur, 1) : 1;
      _playerPx = {
        x: anim.slide2FromPx.x + (anim.slide2To.x - anim.slide2FromPx.x) * t,
        y: anim.slide2FromPx.y + (anim.slide2To.y - anim.slide2FromPx.y) * t,
      };
      if (t >= 1) {
        _playerPx  = { ...anim.slide2To };
        _playerAnim = null;
        anim.onDone();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render
// ─────────────────────────────────────────────────────────────────────────────

function _render(now) {
  const ctx = _ctx;
  const W   = _canvas.width;
  const H   = _canvas.height;
  const t   = (now - _t0) / 1000;

  ctx.clearRect(0, 0, W, H);
  _renderSky(ctx, t);
  _renderCells(ctx, now);
  _renderChain(ctx);
  _renderGoal(ctx);
  _renderPlayer(ctx, now);
  _updateGearHearts();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sky / waterline / boat
// ─────────────────────────────────────────────────────────────────────────────

function _renderSky(ctx, t) {
  const W = _canvas.width;
  // Sky fill
  ctx.fillStyle = '#4a8ac8';
  ctx.fillRect(0, 0, W, BOAT_ROWS * TILE);
  // Horizon band
  ctx.fillStyle = '#6aaee0';
  ctx.fillRect(0, BOAT_ROWS * TILE - 6, W, 4);

  _renderBoat(ctx, _level.start.x, t);

  // Wavy waterline pixels
  const baseY = BOAT_ROWS * TILE - 2;
  ctx.fillStyle = '#88d0f8';
  for (let px = 0; px < W; px++) {
    const dy = Math.round(
      Math.sin(px * 0.38 - t * 1.8) * 1.5 +
      Math.sin(px * 0.72 + t * 2.6) * 0.5
    );
    ctx.fillRect(px, baseY + dy, 1, 2);
  }
}

function _renderBoat(ctx, startX, t) {
  const bob  = Math.sin(t * 1.3) * 1.2;
  const tilt = Math.sin(t * 0.85) * 0.018;
  const cx   = startX * TILE + TILE / 2;
  const by   = BOAT_ROWS * TILE - 2 + bob;

  ctx.save();
  ctx.translate(cx, by);
  ctx.rotate(tilt);

  // hull
  ctx.fillStyle = '#4a2e08';
  ctx.beginPath();
  ctx.moveTo(-36, -3);
  ctx.lineTo( 36, -3);
  ctx.lineTo( 30,  5);
  ctx.lineTo(-30,  5);
  ctx.closePath();
  ctx.fill();

  // deck rail
  ctx.fillStyle = '#7a4e18';
  ctx.fillRect(-32, -8, 64, 5);

  // cabin
  ctx.fillStyle = '#b87018';
  ctx.fillRect(-10, -20, 20, 13);

  // cabin windows
  ctx.fillStyle = '#88ccff';
  ctx.fillRect(-8, -17, 5, 5);
  ctx.fillRect( 3, -17, 5, 5);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-8, -17, 2, 2);
  ctx.fillRect( 3, -17, 2, 2);

  // mast
  ctx.fillStyle = '#2a1a04';
  ctx.fillRect(-1, -30, 2, 12);

  // chain hole
  ctx.fillStyle = '#1a1208';
  ctx.fillRect(-1, -2, 2, 7);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid cells
// ─────────────────────────────────────────────────────────────────────────────

function _renderCells(ctx, now) {
  const { width, height, cells } = _level;
  // Water background for the whole grid area
  ctx.fillStyle = '#2d5a8a';
  ctx.fillRect(0, BOAT_ROWS * TILE, width * TILE, height * TILE);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      _renderCell(ctx, x, y, cells[y * width + x],
                  x * TILE, (y + BOAT_ROWS) * TILE, now);
    }
  }
}

function _renderCell(ctx, gx, gy, type, px, py, now) {
  switch (type) {
    case CellType.EMPTY:
      // water already filled by background
      break;

    case CellType.WALL:
      ctx.fillStyle = '#2b2926';
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(px, py, TILE, 1);
      ctx.fillRect(px, py, 1, TILE);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(px, py + TILE - 1, TILE, 1);
      ctx.fillRect(px + TILE - 1, py, 1, TILE);
      break;

    case CellType.STICKY:
      ctx.fillStyle = '#c8a060';
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = 'rgba(100,60,0,0.28)';
      for (let i = 3; i < TILE; i += 4)
        for (let j = 3; j < TILE; j += 4)
          ctx.fillRect(px + i, py + j, 1, 1);
      break;

    case CellType.CRUMBLE: {
      const key    = `${gx},${gy}`;
      const startT = _crumbles.get(key);
      // Always draw water beneath a crumble cell
      ctx.fillStyle = '#2d5a8a';
      ctx.fillRect(px, py, TILE, TILE);
      if (startT !== undefined) {
        const p = Math.min((now - startT) / 280, 1);
        if (p < 1) {
          ctx.save();
          ctx.translate(px + TILE / 2, py + TILE / 2);
          ctx.scale(1 - p, 1 - p);
          _drawCrumbleTile(ctx);
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.translate(px + TILE / 2, py + TILE / 2);
        _drawCrumbleTile(ctx);
        ctx.restore();
      }
      break;
    }

    case CellType.ONEWAY_LEFT:
    case CellType.ONEWAY_RIGHT:
    case CellType.ONEWAY_UP:
    case CellType.ONEWAY_DOWN:
      ctx.fillStyle = '#4a8870';
      ctx.fillRect(px, py, TILE, TILE);
      _drawArrow(ctx, px + TILE / 2, py + TILE / 2, type);
      break;

    case CellType.TELEPORTER:
      ctx.fillStyle = '#1e0c38';
      ctx.fillRect(px, py, TILE, TILE);
      ctx.strokeStyle = 'rgba(185,95,255,0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);
      ctx.beginPath();
      ctx.arc(px + TILE / 2, py + TILE / 2, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(185,95,255,0.2)';
      ctx.beginPath();
      ctx.arc(px + TILE / 2, py + TILE / 2, 4, 0, Math.PI * 2);
      ctx.fill();
      break;

    default:
      // unknown / removed types: leave as water
      break;
  }
}

function _drawCrumbleTile(ctx) {
  ctx.fillStyle = '#7d5a40';
  ctx.fillRect(-TILE / 2, -TILE / 2, TILE, TILE);
  ctx.fillStyle = '#6a4a34';
  ctx.fillRect(-TILE / 2, -TILE / 2, TILE, 1);
  ctx.fillRect(-TILE / 2, -TILE / 2, 1, TILE);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-4, -6); ctx.lineTo(1, -1); ctx.lineTo(-2, 5);
  ctx.moveTo( 3, -5); ctx.lineTo(-1,  1); ctx.lineTo( 3, 4);
  ctx.stroke();
}

function _drawArrow(ctx, cx, cy, type) {
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.beginPath();
  switch (type) {
    case CellType.ONEWAY_LEFT:
      ctx.moveTo(cx - 5, cy);
      ctx.lineTo(cx + 4, cy - 4);
      ctx.lineTo(cx + 4, cy + 4);
      break;
    case CellType.ONEWAY_RIGHT:
      ctx.moveTo(cx + 5, cy);
      ctx.lineTo(cx - 4, cy - 4);
      ctx.lineTo(cx - 4, cy + 4);
      break;
    case CellType.ONEWAY_UP:
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx - 4, cy + 4);
      ctx.lineTo(cx + 4, cy + 4);
      break;
    case CellType.ONEWAY_DOWN:
      ctx.moveTo(cx, cy + 5);
      ctx.lineTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 4, cy - 4);
      break;
  }
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain
// ─────────────────────────────────────────────────────────────────────────────

// Build lean-offset polyline for one chain segment (boat/teleport-exit → player).
// At each interior gear (bend) the chain is offset LINK_LEAN px to the
// CW or CCW side so it visually runs along the outer face of the gear.
function _buildLeanPoints(rawPoints) {
  const N = rawPoints.length;
  if (N < 2) return rawPoints.map(p => ({ ...p }));
  const R = LINK_LEAN;

  const dirs = [];
  for (let i = 1; i < N; i++) {
    const dx = rawPoints[i].x - rawPoints[i - 1].x;
    const dy = rawPoints[i].y - rawPoints[i - 1].y;
    const l  = Math.hypot(dx, dy);
    dirs.push(l > 0.01 ? { x: dx / l, y: dy / l } : { x: 1, y: 0 });
  }

  // +1 = CW visual turn (screen y-down) → chain on right of travel direction
  // -1 = CCW visual turn → chain on left
  const lds = new Array(N).fill(1);
  if (N >= 3) {
    let prevLD = 1;
    for (let i = 1; i < N - 1; i++) {
      const cross = dirs[i - 1].x * dirs[i].y - dirs[i - 1].y * dirs[i].x;
      const ld = cross !== 0 ? Math.sign(cross) : prevLD;
      prevLD = ld;
      lds[i] = ld;
    }
    lds[0]     = lds[1];
    lds[N - 1] = lds[N - 2];
  }

  const off = (d, ld) => ld > 0
    ? { x: d.y * R,  y: -d.x * R }
    : { x: -d.y * R, y:  d.x * R };

  // Boat endpoint stays at center — chain exits straight from the boat.
  const out = [{ ...rawPoints[0] }];

  for (let i = 1; i < N - 1; i++) {
    const oi = off(dirs[i - 1], lds[i]);  // end of incoming segment
    const oo = off(dirs[i],     lds[i]);  // start of outgoing segment
    const ep = { x: rawPoints[i].x + oi.x, y: rawPoints[i].y + oi.y };
    const xp = { x: rawPoints[i].x + oo.x, y: rawPoints[i].y + oo.y };

    if (Math.abs(ep.x - xp.x) < 0.5 && Math.abs(ep.y - xp.y) < 0.5) {
      out.push(ep);
    } else {
      // L-corner: pick the outer corner (farther from the gear centre).
      const c  = rawPoints[i];
      const ca = { x: xp.x, y: ep.y };
      const cb = { x: ep.x, y: xp.y };
      const corner = Math.hypot(ca.x - c.x, ca.y - c.y) >= Math.hypot(cb.x - c.x, cb.y - c.y)
        ? ca : cb;
      out.push(ep);
      out.push(corner);
      out.push(xp);
    }
  }

  // Player/tail endpoint stays at center — chain arrives straight at the player.
  out.push({ ...rawPoints[N - 1] });
  return out;
}

// Darker version of chain colour for the gap pixels between links.
function _chainDimColor(cellDist) {
  for (const { upTo, r, g, b } of CHAIN_STOPS) {
    if (cellDist < upTo) return `rgb(${Math.round(r*0.85)},${Math.round(g*0.85)},${Math.round(b*0.85)})`;
  }
  const { r, g, b } = CHAIN_STOPS[CHAIN_STOPS.length - 1];
  return `rgb(${Math.round(r*0.85)},${Math.round(g*0.85)},${Math.round(b*0.85)})`;
}

// Draw one lean polyline segment as chain links.
// Pass 1 – hollow rectangular link bodies (holes stay empty — nothing drawn inside).
// Pass 2 – thin 1 px connector line on top, overlapping the rect edges on both sides.
function _drawChainSegment(ctx, pts, distFromTailPx, totalChainLen) {
  if (pts.length < 2) return;

  // Build sub-segment list for position sampling
  const segs = [];
  let totalLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len > 0.01) {
      segs.push({ x0: pts[i-1].x, y0: pts[i-1].y, dx, dy, len, cumLen: totalLen });
      totalLen += len;
    }
  }
  if (!segs.length) return;

  function sampleAt(d) {
    d = Math.max(0, Math.min(d, totalLen));
    for (const s of segs) {
      if (d <= s.cumLen + s.len + 0.001) {
        const t = s.len > 0 ? (d - s.cumLen) / s.len : 0;
        return { x: s.x0 + s.dx * t, y: s.y0 + s.dy * t,
                 isHoriz: Math.abs(s.dx) >= Math.abs(s.dy) };
      }
    }
    const s = segs[segs.length - 1];
    return { x: s.x0 + s.dx, y: s.y0 + s.dy,
             isHoriz: Math.abs(s.dx) >= Math.abs(s.dy) };
  }

  // ── Pass 1: hollow link rectangles (drawn first so holes stay empty) ───────
  // Link k centre sits at distFromBoat = (LINK_LINE + LINK_RECT/2) + k*LINK_TOT from boat.
  // In terms of position d along this segment (player-side = 0):
  //   d = totalChainLen - distFromTailPx - (LINK_LINE + LINK_RECT/2) - k*LINK_TOT
  const base = totalChainLen - distFromTailPx - (LINK_LINE + LINK_RECT / 2);
  const kMin = Math.ceil((base - totalLen) / LINK_TOT);
  const kMax = Math.floor(base / LINK_TOT);

  for (let k = kMin; k <= kMax; k++) {
    const d = base - k * LINK_TOT;
    if (d < 0 || d > totalLen) continue;

    const pt  = sampleAt(d);
    const col = _chainColor((distFromTailPx + totalLen - d) / TILE);
    const cx  = Math.round(pt.x);
    const cy  = Math.round(pt.y);

    ctx.fillStyle = col;
    if (pt.isHoriz) {
      // 5 wide × 3 tall — hole is 3×1 in the middle
      ctx.fillRect(cx - 2, cy - 1, 5, 1);  // top edge
      ctx.fillRect(cx - 2, cy + 1, 5, 1);  // bottom edge
      ctx.fillRect(cx - 2, cy - 1, 1, 3);  // left edge
      ctx.fillRect(cx + 2, cy - 1, 1, 3);  // right edge
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(cx - 2, cy - 1, 1, 1);  // top-left corner
      ctx.fillRect(cx + 2, cy - 1, 1, 1);  // top-right corner
      ctx.fillRect(cx - 2, cy + 1, 1, 1);  // bottom-left corner
      ctx.fillRect(cx + 2, cy + 1, 1, 1);  // bottom-right corner
    } else {
      // 3 wide × 5 tall — hole is 1×3 in the middle
      ctx.fillRect(cx - 1, cy - 2, 3, 1);  // top edge
      ctx.fillRect(cx - 1, cy + 2, 3, 1);  // bottom edge
      ctx.fillRect(cx - 1, cy - 2, 1, 5);  // left edge
      ctx.fillRect(cx + 1, cy - 2, 1, 5);  // right edge
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(cx - 1, cy - 2, 1, 1);  // top-left corner
      ctx.fillRect(cx + 1, cy - 2, 1, 1);  // top-right corner
      ctx.fillRect(cx - 1, cy + 2, 1, 1);  // bottom-left corner
      ctx.fillRect(cx + 1, cy + 2, 1, 1);  // bottom-right corner
    }
  }

  // ── Pass 2: thin 1 px connector on top ─────────────────────────────────────
  // Drawn only in the connector zone + 1 px overlap into each rect edge.
  // Pixels inside the rect interior are skipped so the hole stays empty.
  let cumLen = 0;
  for (const s of segs) {
    const steps = Math.ceil(s.len);
    for (let st = 0; st <= steps; st++) {
      const t      = s.len > 0 ? st / steps : 0;
      const dSeg   = cumLen + t * s.len;   // distance from boat-end of this segment
      // Phase must stay boat-anchored (same reference as rect placement in Pass 1).
      const distFromBoat = totalChainLen - distFromTailPx - dSeg;
      const phase        = ((distFromBoat % LINK_TOT) + LINK_TOT) % LINK_TOT;
      // Skip the rect interior (phases LINK_LINE+1 … LINK_TOT-2); keep the
      // 1 px on each rect edge so the wire visibly overlaps the rectangle.
      if (phase > LINK_LINE && phase < LINK_TOT - 1) continue;
      // Color uses distance from player end (totalLen - dSeg from player-end of segment).
      ctx.fillStyle = _chainDimColor((distFromTailPx + totalLen - dSeg) / TILE);
      ctx.fillRect(Math.round(s.x0 + s.dx * t), Math.round(s.y0 + s.dy * t), 1, 1);
    }
    cumLen += s.len;
  }
}

function _renderChain(ctx) {
  if (!_level) return;
  const tailPx = _chainTailPx ?? _playerPx;
  const boatPx = _cellCanvasPx(_level.start.x, -1);

  // Build full point arrays per segment (split at teleporter crossings)
  const rawSegs = [];
  const bridges = [];
  let cur = [boatPx];

  for (const g of _chainGears) {
    if (g.isTeleport) {
      cur.push(_cellCanvasPx(g.x, g.y));
      rawSegs.push(cur);
      const exitPx = _cellCanvasPx(g.exitX, g.exitY);
      bridges.push({ from: cur[cur.length - 1], to: exitPx });
      cur = [exitPx];
    } else {
      cur.push(_cellCanvasPx(g.x, g.y));
    }
  }
  cur.push(tailPx);
  rawSegs.push(cur);

  // Pre-build lean paths and measure their actual lengths for phase-locking.
  // Using lean lengths (not raw) keeps rect positions and wire phases in sync.
  const leanSegs = rawSegs.map(_buildLeanPoints);
  const segLens  = leanSegs.map(pts => {
    let l = 0;
    for (let i = 1; i < pts.length; i++)
      l += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    return l;
  });
  const totalChainLen = segLens.reduce((a, b) => a + b, 0);

  // Draw chain, player-end segment first (distFromTail = 0 there)
  let distFromTail = 0;
  for (let si = leanSegs.length - 1; si >= 0; si--) {
    _drawChainSegment(ctx, leanSegs[si], distFromTail, totalChainLen);
    distFromTail += segLens[si];
  }

  // Teleporter bridges (dashed)
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  ctx.strokeStyle = 'rgba(190,100,255,0.65)';
  for (const { from, to } of bridges) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Gear squares at each bend / portals at teleporters
  for (const g of _chainGears) {
    if (g.isTeleport) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(210,130,255,0.9)';
      for (const { x, y } of [{ x: g.x, y: g.y }, { x: g.exitX, y: g.exitY }]) {
        const pp = _cellCanvasPx(x, y);
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      _drawGearSquare(ctx, _cellCanvasPx(g.x, g.y));
    }
  }

  // Tail gear at player / tail position
  _drawGearSquare(ctx, tailPx);
}

function _drawGearSquare(ctx, { x, y }) {
  ctx.fillStyle = '#1e2d4a';
  ctx.fillRect(x - 3, y - 3, 6, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(x - 3, y - 3, 3, 1);
  ctx.fillRect(x - 3, y - 3, 1, 3);
}

function _chainColor(cellDist) {
  for (const { upTo, r, g, b } of CHAIN_STOPS) {
    if (cellDist < upTo) return `rgb(${r},${g},${b})`;
  }
  const { r, g, b } = CHAIN_STOPS[CHAIN_STOPS.length - 1];
  return `rgb(${r},${g},${b})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal
// ─────────────────────────────────────────────────────────────────────────────

function _renderGoal(ctx) {
  if (!_level) return;
  let gx, gy;
  if (_goalFollowsPlayer) {
    gx = _playerPx.x;
    gy = _playerPx.y;
  } else {
    gx = _level.goal.x * TILE + TILE / 2;
    gy = (_level.goal.y + BOAT_ROWS) * TILE + TILE / 2;
  }
  ctx.save();
  ctx.translate(gx, gy);
  // Five-pointed star
  ctx.fillStyle = '#e8a020';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI / 5) - Math.PI / 2;
    const r = i % 2 === 0 ? 7 : 3;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else         ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,220,80,0.6)';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI / 5) - Math.PI / 2;
    const r = i % 2 === 0 ? 4 : 1.5;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else         ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Player
// ─────────────────────────────────────────────────────────────────────────────

function _renderPlayer(ctx, now) {
  if (!_level) return;

  if (_explodeAnim) {
    const EXPLODE_MS = 550;
    const et    = Math.min((now - _explodeAnim.startTime) / EXPLODE_MS, 1);
    const scale = et < 0.4 ? 1 + (et / 0.4) * 1.2 : Math.max(0.05, 1 - (et - 0.4) / 0.6);
    const alpha = et < 0.4 ? 1 : Math.max(0, 1 - (et - 0.4) / 0.6);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(_explodeAnim.startPx.x, _explodeAnim.startPx.y);
    ctx.scale(scale, scale);
    _drawPlayerSprite(ctx);
    ctx.restore();
    if (et >= 1) {
      const cb = _explodeAnim.onDone;
      _explodeAnim = null;
      cb?.();
    }
    return;
  }

  let px = _playerPx.x;
  let py = _playerPx.y;

  // Jerk offset
  if (_jerkState) {
    const JERK_MS = 260 * _speedMult;
    const jt = Math.min((now - _jerkState.startTime) / JERK_MS, 1);
    const offset = 5 * Math.exp(-5 * jt) * Math.sin(Math.PI * 2 * 1.2 * jt);
    px += _jerkState.dx * offset;
    py += _jerkState.dy * offset;
    if (jt >= 1) _jerkState = null;
  }

  ctx.save();
  ctx.globalAlpha = _playerOpacity;
  ctx.translate(px, py);
  _drawPlayerSprite(ctx);
  ctx.restore();
}

function _drawPlayerSprite(ctx) {
  ctx.fillStyle = '#3a6fd8';
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5a8ff8';
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(-2, -2, 2, 0, Math.PI * 2);
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// Gear hearts DOM update
// ─────────────────────────────────────────────────────────────────────────────

function _updateGearHearts() {
  if (!_gearHeartsEl || _totalGears <= 0) return;
  if (_gearHeartsEl.dataset.filled  === String(_gearsLeft) &&
      _gearHeartsEl.dataset.total   === String(_totalGears)) return;
  _gearHeartsEl.dataset.filled = _gearsLeft;
  _gearHeartsEl.dataset.total  = _totalGears;
  _gearHeartsEl.innerHTML = '';
  for (let i = 0; i < _totalGears; i++) {
    const h = document.createElement('div');
    h.className = i < _gearsLeft ? 'gear-heart full' : 'gear-heart empty';
    _gearHeartsEl.appendChild(h);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _cellCanvasPx(x, y) {
  return {
    x: x * TILE + TILE / 2,
    y: (y + BOAT_ROWS) * TILE + TILE / 2,
  };
}

function _resizeCanvas() {
  if (!_canvas || !_containerEl || !_level) return;
  const rect    = _containerEl.getBoundingClientRect();
  const aspectW = _level.width;
  const aspectH = _level.height + BOAT_ROWS;
  let h = Math.min(rect.height, rect.width * aspectH / aspectW);
  let w = h * aspectW / aspectH;
  _canvas.style.width  = Math.round(w) + 'px';
  _canvas.style.height = Math.round(h) + 'px';
}

function _canvasScale() {
  if (!_canvas) return 1;
  const r = _canvas.getBoundingClientRect();
  return r.width / _canvas.width;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function buildGrid(container, level) {
  container.innerHTML = '';
  if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }

  _level        = level;
  _containerEl  = container;
  _gearHeartsEl = document.getElementById('gear-hearts');

  _crumbles.clear();
  _explodeAnim   = null;
  _playerAnim    = null;
  _jerkState     = null;
  _chainGears    = [];
  _chainTailPx   = null;
  _playerOpacity = 1;
  _animToken     = 0;
  _gearsLeft     = 0;
  _totalGears    = 0;

  _canvas = document.createElement('canvas');
  _canvas.width  = level.width  * TILE;
  _canvas.height = (level.height + BOAT_ROWS) * TILE;
  _canvas.className = 'pixel-canvas';
  container.appendChild(_canvas);
  _ctx = _canvas.getContext('2d');

  _resizeCanvas();
  _startLoop();
}

export function placePlayer(pos, level) {
  _playerPx = _cellCanvasPx(pos.x, pos.y);
}

export function animatePlayer(from, to, level, onDone, teleportInfo = null, jerkDir = null) {
  const token   = ++_animToken;
  const speedMs = SPEED_BASE * _speedMult;
  _playerOpacity = 1;

  if (!teleportInfo) {
    const steps  = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    if (steps === 0) { onDone(); return; }
    const fromPx = _cellCanvasPx(from.x, from.y);
    const toPx   = _cellCanvasPx(to.x,   to.y);
    _playerPx   = { ...fromPx };
    _playerAnim = {
      type:      'slide',
      from:      fromPx,
      to:        toPx,
      startTime: performance.now(),
      dur:       steps * speedMs,
      onDone: () => {
        if (token !== _animToken) return;
        if (jerkDir) {
          _jerkState = {
            endPx:     toPx,
            dx:        jerkDir.dx,
            dy:        jerkDir.dy,
            startTime: performance.now(),
          };
        }
        onDone();
      },
    };
    return;
  }

  // Teleport: three phases
  const { entryPos, exitPos, onTeleportCrossing } = teleportInfo;
  const fromPx  = _cellCanvasPx(from.x,     from.y);
  const entryPx = _cellCanvasPx(entryPos.x, entryPos.y);
  const exitPx  = _cellCanvasPx(exitPos.x,  exitPos.y);
  const toPx    = _cellCanvasPx(to.x,       to.y);
  const steps1  = Math.max(Math.abs(entryPos.x - from.x), Math.abs(entryPos.y - from.y));
  const steps3  = Math.max(Math.abs(to.x - exitPos.x),    Math.abs(to.y - exitPos.y));

  _playerPx   = { ...fromPx };
  _playerAnim = {
    type:              'teleport',
    phase:             'slide1',
    slide1From:        fromPx,
    entryPx,
    exitPx,
    slide2To:          toPx,
    slide1Dur:         steps1 * speedMs,
    slide2Dur:         steps3 * speedMs,
    startTime:         performance.now(),
    flashStart:        0,
    onTeleportCrossing,
    flashJumped:       false,
    onDone: () => {
      if (token !== _animToken) return;
      onDone();
    },
  };
}

export function animateChainJerkInPlace(pos, dir, level) {
  _jerkState = {
    endPx:     _cellCanvasPx(pos.x, pos.y),
    dx:        dir.dx,
    dy:        dir.dy,
    startTime: performance.now(),
  };
}

export function repositionOverlays(playerPos, level) {
  _level    = level;
  _playerPx = _cellCanvasPx(playerPos.x, playerPos.y);
  _resizeCanvas();
  if (_diveIndicatorEl) _updateDiveIndicatorPos();
}

export function drawChain(gears, playerPos, gearsLeft, totalGears, level) {
  _chainGears  = gears;
  _chainTailPx = null;
  _gearsLeft   = gearsLeft;
  _totalGears  = totalGears;
}

export function drawChainWithPixelTail(gears, tailPx, gearsLeft, totalGears, level) {
  _chainGears  = gears;
  _chainTailPx = tailPx;
  _gearsLeft   = gearsLeft;
  _totalGears  = totalGears;
}

export function getCellPixel(x, y, level) {
  return _cellCanvasPx(x, y);
}

export function explodePlayer(onDone) {
  _explodeAnim = {
    startPx:   { ..._playerPx },
    startTime: performance.now(),
    onDone,
  };
}

export function removeCrumble(x, y, level) {
  _crumbles.set(`${x},${y}`, performance.now());
}

// ── dive indicator ────────────────────────────────────────────────────────────

export function showDiveIndicator(level) {
  hideDiveIndicator();
  if (!_containerEl) return;
  _diveIndicatorEl = document.createElement('div');
  _diveIndicatorEl.className = 'dive-indicator';
  const arrow = document.createElement('div');
  arrow.className   = 'dive-arrow';
  arrow.textContent = '▼';
  const hint = document.createElement('div');
  hint.className   = 'dive-hint';
  hint.textContent = 'Drag down or press ↓ to dive';
  _diveIndicatorEl.appendChild(arrow);
  _diveIndicatorEl.appendChild(hint);
  _containerEl.appendChild(_diveIndicatorEl);
  requestAnimationFrame(() => _updateDiveIndicatorPos());
}

function _updateDiveIndicatorPos() {
  if (!_diveIndicatorEl || !_canvas || !_level) return;
  const scale      = _canvasScale();
  const canvasRect = _canvas.getBoundingClientRect();
  const contRect   = _containerEl.getBoundingClientRect();
  const cellCssPx  = TILE * scale;
  const left = (canvasRect.left - contRect.left) + (_level.start.x + 0.5) * cellCssPx;
  const top  = (canvasRect.top  - contRect.top)  + (BOAT_ROWS + 1.5)      * cellCssPx;
  _diveIndicatorEl.style.left     = left + 'px';
  _diveIndicatorEl.style.top      = top  + 'px';
  _diveIndicatorEl.style.fontSize = Math.round(cellCssPx * 0.72) + 'px';
}

export function hideDiveIndicator() {
  if (!_diveIndicatorEl) return;
  _diveIndicatorEl.classList.add('hiding');
  const el = _diveIndicatorEl;
  _diveIndicatorEl = null;
  setTimeout(() => el.remove(), 280);
}

export function showDiveHint() {
  if (!_diveIndicatorEl) return;
  const hint = _diveIndicatorEl.querySelector('.dive-hint');
  if (hint) hint.classList.add('visible');
}

// ── move hint ─────────────────────────────────────────────────────────────────

export function showMoveHint() {
  if (_moveHintEl || !_containerEl || !_canvas) return;
  const canvasRect = _canvas.getBoundingClientRect();
  const contRect   = _containerEl.getBoundingClientRect();
  const cx = (canvasRect.left - contRect.left) + canvasRect.width  * 0.5;
  const cy = (canvasRect.top  - contRect.top)  + canvasRect.height * 0.68;
  _moveHintEl = document.createElement('div');
  _moveHintEl.className   = 'move-hint';
  _moveHintEl.textContent = 'Drag in any direction or press an arrow key to move';
  _moveHintEl.style.left  = cx + 'px';
  _moveHintEl.style.top   = cy + 'px';
  _containerEl.appendChild(_moveHintEl);
  requestAnimationFrame(() => { if (_moveHintEl) _moveHintEl.classList.add('visible'); });
}

export function hideMoveHint() {
  if (!_moveHintEl) return;
  _moveHintEl.classList.add('hiding');
  const el = _moveHintEl;
  _moveHintEl = null;
  setTimeout(() => el.remove(), 320);
}
