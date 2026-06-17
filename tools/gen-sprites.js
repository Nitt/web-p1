#!/usr/bin/env node
'use strict';
// Run: node tools/gen-sprites.js
// Writes starter PNGs to assets/sprites/. Replace them with your own art in Aseprite.

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── PNG encoder ───────────────────────────────────────────────────────────────

const CRC_TBL = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TBL[n] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TBL[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const body  = Buffer.concat([typeB, data]);
  const len   = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc   = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit-depth=8, RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter None
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (1 + w * 4) + 1 + x * 4;
      raw[d] = rgba[s]; raw[d+1] = rgba[s+1]; raw[d+2] = rgba[s+2]; raw[d+3] = rgba[s+3];
    }
  }
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── pixel buffer ──────────────────────────────────────────────────────────────

function newBuf(w, h) { return { w, h, data: new Uint8Array(w * h * 4) }; }

function blend(buf, x, y, r, g, b, a) {
  if (x < 0 || x >= buf.w || y < 0 || y >= buf.h) return;
  const i = (y * buf.w + x) * 4, fa = a / 255, ia = 1 - fa;
  buf.data[i]   = Math.round(buf.data[i]   * ia + r * fa);
  buf.data[i+1] = Math.round(buf.data[i+1] * ia + g * fa);
  buf.data[i+2] = Math.round(buf.data[i+2] * ia + b * fa);
  buf.data[i+3] = Math.min(255, buf.data[i+3] + a);
}

function hex(s)         { const n = parseInt(s.slice(1), 16); return [(n>>16)&0xFF, (n>>8)&0xFF, n&0xFF, 255]; }
function rgba(r,g,b,a)  { return [r, g, b, Math.round(a * 255)]; }

function fillRect(buf, x, y, w, h, col) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      blend(buf, x+dx, y+dy, ...col);
}

function pixLine(buf, x0, y0, x1, y1, col) {
  const steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i/steps : 0;
    blend(buf, Math.round(x0+(x1-x0)*t), Math.round(y0+(y1-y0)*t), ...col);
  }
}

function fillCircle(buf, cx, cy, r, col) {
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.round(Math.sqrt(r*r - dy*dy));
    for (let dx = -hw; dx <= hw; dx++) blend(buf, cx+dx, cy+dy, ...col);
  }
}

function strokeCircle(buf, cx, cy, r, col) {
  for (let dy = -(r+1); dy <= r+1; dy++)
    for (let dx = -(r+1); dx <= r+1; dx++) {
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d >= r - 0.5 && d <= r + 0.5) blend(buf, cx+dx, cy+dy, ...col);
    }
}

function fillTriangle(buf, x0, y0, x1, y1, x2, y2, col) {
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(buf.h-1, Math.ceil(Math.max(y0, y1, y2)));
  const edges = [[x0,y0,x1,y1],[x1,y1,x2,y2],[x2,y2,x0,y0]];
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (const [ax,ay,bx,by] of edges)
      if ((ay <= y && by > y) || (by <= y && ay > y))
        xs.push(ax + (y-ay)*(bx-ax)/(by-ay));
    if (xs.length >= 2) {
      xs.sort((a,b) => a-b);
      for (let x = Math.ceil(xs[0]); x <= Math.floor(xs[xs.length-1]); x++)
        blend(buf, x, y, ...col);
    }
  }
}

function fillPolygon(buf, pts, col) {
  const ys = pts.map(p => p.y);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(buf.h-1, Math.ceil(Math.max(...ys)));
  const n = pts.length;
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const {x:ax, y:ay} = pts[i], {x:bx, y:by} = pts[(i+1)%n];
      if ((ay <= y && by > y) || (by <= y && ay > y))
        xs.push(ax + (y-ay)*(bx-ax)/(by-ay));
    }
    if (xs.length >= 2) {
      xs.sort((a,b) => a-b);
      for (let x = Math.ceil(xs[0]); x <= Math.floor(xs[xs.length-1]); x++)
        blend(buf, x, y, ...col);
    }
  }
}

// ── sprite draw functions ─────────────────────────────────────────────────────

const T = 16;

function drawWall() {
  const buf = newBuf(T, T);
  fillRect(buf, 0,0,T,T, hex('#2b2926'));
  fillRect(buf, 0,0,T,1, rgba(255,255,255,0.07));
  fillRect(buf, 0,0,1,T, rgba(255,255,255,0.07));
  fillRect(buf, 0,T-1,T,1, rgba(0,0,0,0.3));
  fillRect(buf, T-1,0,1,T, rgba(0,0,0,0.3));
  return buf;
}

function drawSticky() {
  const buf = newBuf(T, T);
  fillRect(buf, 0,0,T,T, hex('#c8a060'));
  for (let i = 3; i < T; i += 4)
    for (let j = 3; j < T; j += 4)
      fillRect(buf, i,j,1,1, rgba(100,60,0,0.28));
  return buf;
}

function drawCrumble() {
  const buf = newBuf(T, T);
  fillRect(buf, 0,0,T,T, hex('#7d5a40'));
  fillRect(buf, 0,0,T,1, hex('#6a4a34'));
  fillRect(buf, 0,0,1,T, hex('#6a4a34'));
  const c = rgba(0,0,0,0.55);
  pixLine(buf,  4,2,  9,7, c);  pixLine(buf,  9,7,  6,13, c);
  pixLine(buf, 11,3,  7,9, c);  pixLine(buf,  7,9, 11,12, c);
  return buf;
}

function drawOneway(dir) {
  const buf = newBuf(T, T);
  fillRect(buf, 0,0,T,T, hex('#4a8870'));
  const CX = T/2, CY = T/2, col = rgba(255,255,255,0.88);
  if (dir === 'L') fillTriangle(buf, CX-5,CY, CX+4,CY-4, CX+4,CY+4, col);
  if (dir === 'R') fillTriangle(buf, CX+5,CY, CX-4,CY-4, CX-4,CY+4, col);
  if (dir === 'U') fillTriangle(buf, CX,CY-5, CX-4,CY+4, CX+4,CY+4, col);
  if (dir === 'D') fillTriangle(buf, CX,CY+5, CX-4,CY-4, CX+4,CY-4, col);
  return buf;
}

function drawTeleport() {
  const buf = newBuf(T, T);
  fillRect(buf, 0,0,T,T, hex('#1e0c38'));
  const bc = rgba(185,95,255,0.85), fc = rgba(185,95,255,0.2);
  // 1px inset border
  fillRect(buf, 1,1,T-2,1,bc); fillRect(buf, 1,T-2,T-2,1,bc);
  fillRect(buf, 1,2,1,T-4,bc); fillRect(buf, T-2,2,1,T-4,bc);
  // circle at center r=4
  const CX = T/2, CY = T/2;
  fillCircle(buf, CX, CY, 4, fc);
  strokeCircle(buf, CX, CY, 4, bc);
  return buf;
}

function drawPlayer() {
  const buf = newBuf(T, T);
  const CX = T/2, CY = T/2;
  fillCircle(buf, CX, CY, 6, hex('#3a6fd8'));
  fillCircle(buf, CX, CY, 4, hex('#5a8ff8'));
  fillCircle(buf, CX-2, CY-2, 2, rgba(255,255,255,0.5));
  return buf;
}

function starPts(cx, cy, r1, r2, n) {
  const pts = [];
  for (let i = 0; i < n*2; i++) {
    const a = (i * Math.PI/n) - Math.PI/2, r = i%2===0 ? r1 : r2;
    pts.push({ x: cx + Math.cos(a)*r, y: cy + Math.sin(a)*r });
  }
  return pts;
}

function drawGoal() {
  const buf = newBuf(T, T);
  const CX = T/2, CY = T/2;
  fillPolygon(buf, starPts(CX, CY, 7, 3, 5), hex('#e8a020'));
  fillPolygon(buf, starPts(CX, CY, 4, 1.5, 5), rgba(255,220,80,0.6));
  return buf;
}

function drawBoat() {
  const W = 80, H = 40, buf = newBuf(W, H);
  const AX = 40, AY = 32;
  // hull (trapezoid scanlines)
  for (let dy = -3; dy <= 5; dy++) {
    const hw = Math.round(36 - (dy+3)/8*6);
    fillRect(buf, AX-hw, AY+dy, hw*2, 1, hex('#4a2e08'));
  }
  fillRect(buf, AX-32, AY-8,  64, 5, hex('#7a4e18')); // deck
  fillRect(buf, AX-10, AY-20, 20,13, hex('#b87018')); // cabin
  fillRect(buf, AX-8,  AY-17,  5, 5, hex('#88ccff')); // window L
  fillRect(buf, AX+3,  AY-17,  5, 5, hex('#88ccff')); // window R
  fillRect(buf, AX-8,  AY-17,  2, 2, rgba(255,255,255,0.3));
  fillRect(buf, AX+3,  AY-17,  2, 2, rgba(255,255,255,0.3));
  fillRect(buf, AX-1,  AY-30,  2,12, hex('#2a1a04')); // mast
  fillRect(buf, AX-1,  AY-2,   2, 7, hex('#1a1208')); // chain hole
  return buf;
}

// ── write all sprites ─────────────────────────────────────────────────────────

const OUT = path.join(__dirname, '..', 'assets', 'sprites');
fs.mkdirSync(OUT, { recursive: true });

const SPRITES = [
  ['wall.png',     drawWall()       ],
  ['sticky.png',   drawSticky()     ],
  ['crumble.png',  drawCrumble()    ],
  ['oneway-l.png', drawOneway('L')  ],
  ['oneway-r.png', drawOneway('R')  ],
  ['oneway-u.png', drawOneway('U')  ],
  ['oneway-d.png', drawOneway('D')  ],
  ['teleport.png', drawTeleport()   ],
  ['player.png',   drawPlayer()     ],
  ['goal.png',     drawGoal()       ],
  ['boat.png',     drawBoat()       ],
];

for (const [name, buf] of SPRITES) {
  const outPath = path.join(OUT, name);
  fs.writeFileSync(outPath, encodePNG(buf.w, buf.h, buf.data));
  console.log(`  ${name}  (${buf.w}×${buf.h})`);
}
console.log(`\nWrote ${SPRITES.length} sprites to assets/sprites/`);
