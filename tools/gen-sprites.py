#!/usr/bin/env python3
"""
Writes starter PNGs to assets/sprites/.
Run: python3 tools/gen-sprites.py
Replace the output files with your own art in Aseprite.
"""
import os, zlib, struct, math

# ── PNG encoder ───────────────────────────────────────────────────────────────

def png_chunk(tag, data):
    c = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', c)

def encode_png(w, h, rgba):
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter None
        raw.extend(rgba[y*w*4:(y+1)*w*4])
    idat = zlib.compress(bytes(raw), 9)
    return (b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', idat)
            + png_chunk(b'IEND', b''))

# ── pixel buffer ──────────────────────────────────────────────────────────────

def new_buf(w, h):
    return {'w': w, 'h': h, 'data': bytearray(w * h * 4)}

def blend(buf, x, y, r, g, b, a):
    if x < 0 or x >= buf['w'] or y < 0 or y >= buf['h']:
        return
    i = (y * buf['w'] + x) * 4
    d = buf['data']
    fa = a / 255.0
    ia = 1.0 - fa
    d[i]   = round(d[i]   * ia + r * fa)
    d[i+1] = round(d[i+1] * ia + g * fa)
    d[i+2] = round(d[i+2] * ia + b * fa)
    d[i+3] = min(255, d[i+3] + a)

def from_hex(s):
    n = int(s.lstrip('#'), 16)
    return ((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF, 255)

def from_rgba(r, g, b, a):
    return (r, g, b, round(a * 255))

def fill_rect(buf, x, y, w, h, col):
    for dy in range(h):
        for dx in range(w):
            blend(buf, x+dx, y+dy, *col)

def pix_line(buf, x0, y0, x1, y1, col):
    steps = max(abs(x1-x0), abs(y1-y0))
    for i in range(steps + 1):
        t = i / steps if steps else 0
        blend(buf, round(x0+(x1-x0)*t), round(y0+(y1-y0)*t), *col)

def fill_circle(buf, cx, cy, r, col):
    for dy in range(-r, r+1):
        hw = round(math.sqrt(r*r - dy*dy))
        for dx in range(-hw, hw+1):
            blend(buf, cx+dx, cy+dy, *col)

def stroke_circle(buf, cx, cy, r, col):
    for dy in range(-(r+1), r+2):
        for dx in range(-(r+1), r+2):
            d = math.sqrt(dx*dx + dy*dy)
            if r - 0.5 <= d <= r + 0.5:
                blend(buf, cx+dx, cy+dy, *col)

def fill_triangle(buf, x0, y0, x1, y1, x2, y2, col):
    min_y = max(0, math.floor(min(y0, y1, y2)))
    max_y = min(buf['h']-1, math.ceil(max(y0, y1, y2)))
    edges = [(x0,y0,x1,y1),(x1,y1,x2,y2),(x2,y2,x0,y0)]
    for y in range(min_y, max_y+1):
        xs = []
        for (ax,ay,bx,by) in edges:
            if (ay <= y < by) or (by <= y < ay):
                xs.append(ax + (y-ay)*(bx-ax)/(by-ay))
        if len(xs) >= 2:
            xs.sort()
            for x in range(math.ceil(xs[0]), math.floor(xs[-1])+1):
                blend(buf, x, y, *col)

def fill_polygon(buf, pts, col):
    ys = [p[1] for p in pts]
    min_y = max(0, math.floor(min(ys)))
    max_y = min(buf['h']-1, math.ceil(max(ys)))
    n = len(pts)
    for y in range(min_y, max_y+1):
        xs = []
        for i in range(n):
            ax, ay = pts[i]; bx, by = pts[(i+1)%n]
            if (ay <= y < by) or (by <= y < ay):
                xs.append(ax + (y-ay)*(bx-ax)/(by-ay))
        if len(xs) >= 2:
            xs.sort()
            for x in range(math.ceil(xs[0]), math.floor(xs[-1])+1):
                blend(buf, x, y, *col)

# ── sprite draw functions ─────────────────────────────────────────────────────

T = 16

def draw_wall():
    buf = new_buf(T, T)
    fill_rect(buf, 0,0,T,T, from_hex('#2b2926'))
    fill_rect(buf, 0,0,T,1, from_rgba(255,255,255,0.07))
    fill_rect(buf, 0,0,1,T, from_rgba(255,255,255,0.07))
    fill_rect(buf, 0,T-1,T,1, from_rgba(0,0,0,0.3))
    fill_rect(buf, T-1,0,1,T, from_rgba(0,0,0,0.3))
    return buf

def draw_sticky():
    buf = new_buf(T, T)
    fill_rect(buf, 0,0,T,T, from_hex('#c8a060'))
    dot = from_rgba(100,60,0,0.28)
    for i in range(3, T, 4):
        for j in range(3, T, 4):
            fill_rect(buf, i,j,1,1, dot)
    return buf

def draw_crumble():
    buf = new_buf(T, T)
    fill_rect(buf, 0,0,T,T, from_hex('#7d5a40'))
    fill_rect(buf, 0,0,T,1, from_hex('#6a4a34'))
    fill_rect(buf, 0,0,1,T, from_hex('#6a4a34'))
    c = from_rgba(0,0,0,0.55)
    pix_line(buf,  4,2,  9,7, c);  pix_line(buf,  9,7,  6,13, c)
    pix_line(buf, 11,3,  7,9, c);  pix_line(buf,  7,9, 11,12, c)
    return buf

def draw_oneway(direction):
    buf = new_buf(T, T)
    fill_rect(buf, 0,0,T,T, from_hex('#4a8870'))
    CX, CY = T/2, T/2
    col = from_rgba(255,255,255,0.88)
    if direction == 'L': fill_triangle(buf, CX-5,CY, CX+4,CY-4, CX+4,CY+4, col)
    if direction == 'R': fill_triangle(buf, CX+5,CY, CX-4,CY-4, CX-4,CY+4, col)
    if direction == 'U': fill_triangle(buf, CX,CY-5, CX-4,CY+4, CX+4,CY+4, col)
    if direction == 'D': fill_triangle(buf, CX,CY+5, CX-4,CY-4, CX+4,CY-4, col)
    return buf

def draw_teleport():
    buf = new_buf(T, T)
    fill_rect(buf, 0,0,T,T, from_hex('#1e0c38'))
    bc = from_rgba(185,95,255,0.85)
    fc = from_rgba(185,95,255,0.2)
    fill_rect(buf, 1,1,T-2,1,bc); fill_rect(buf, 1,T-2,T-2,1,bc)
    fill_rect(buf, 1,2,1,T-4,bc); fill_rect(buf, T-2,2,1,T-4,bc)
    CX, CY = T//2, T//2
    fill_circle(buf, CX, CY, 4, fc)
    stroke_circle(buf, CX, CY, 4, bc)
    return buf

def draw_player():
    buf = new_buf(T, T)
    CX, CY = T//2, T//2
    fill_circle(buf, CX, CY, 6, from_hex('#3a6fd8'))
    fill_circle(buf, CX, CY, 4, from_hex('#5a8ff8'))
    fill_circle(buf, CX-2, CY-2, 2, from_rgba(255,255,255,0.5))
    return buf

def star_pts(cx, cy, r1, r2, n):
    pts = []
    for i in range(n*2):
        a = (i * math.pi / n) - math.pi/2
        r = r1 if i%2==0 else r2
        pts.append((cx + math.cos(a)*r, cy + math.sin(a)*r))
    return pts

def draw_goal():
    buf = new_buf(T, T)
    CX, CY = T/2, T/2
    fill_polygon(buf, star_pts(CX, CY, 7, 3, 5), from_hex('#e8a020'))
    fill_polygon(buf, star_pts(CX, CY, 4, 1.5, 5), from_rgba(255,220,80,0.6))
    return buf

def draw_boat():
    W, H = 80, 40
    buf = new_buf(W, H)
    AX, AY = 40, 32
    hull = from_hex('#4a2e08')
    for dy in range(-3, 6):
        hw = round(36 - (dy+3)/8*6)
        fill_rect(buf, AX-hw, AY+dy, hw*2, 1, hull)
    fill_rect(buf, AX-32, AY-8,  64, 5, from_hex('#7a4e18'))
    fill_rect(buf, AX-10, AY-20, 20,13, from_hex('#b87018'))
    fill_rect(buf, AX-8,  AY-17,  5, 5, from_hex('#88ccff'))
    fill_rect(buf, AX+3,  AY-17,  5, 5, from_hex('#88ccff'))
    fill_rect(buf, AX-8,  AY-17,  2, 2, from_rgba(255,255,255,0.3))
    fill_rect(buf, AX+3,  AY-17,  2, 2, from_rgba(255,255,255,0.3))
    fill_rect(buf, AX-1,  AY-30,  2,12, from_hex('#2a1a04'))
    fill_rect(buf, AX-1,  AY-2,   2, 7, from_hex('#1a1208'))
    return buf

# ── write sprites ─────────────────────────────────────────────────────────────

SPRITES = [
    ('wall.png',     draw_wall()),
    ('sticky.png',   draw_sticky()),
    ('crumble.png',  draw_crumble()),
    ('oneway-l.png', draw_oneway('L')),
    ('oneway-r.png', draw_oneway('R')),
    ('oneway-u.png', draw_oneway('U')),
    ('oneway-d.png', draw_oneway('D')),
    ('teleport.png', draw_teleport()),
    ('player.png',   draw_player()),
    ('goal.png',     draw_goal()),
    ('boat.png',     draw_boat()),
]

out_dir = os.path.join(os.path.dirname(__file__), '..', 'assets', 'sprites')
os.makedirs(out_dir, exist_ok=True)

for name, buf in SPRITES:
    path = os.path.join(out_dir, name)
    with open(path, 'wb') as f:
        f.write(encode_png(buf['w'], buf['h'], buf['data']))
    print(f'  {name}  ({buf["w"]}×{buf["h"]})')

print(f'\nWrote {len(SPRITES)} sprites to assets/sprites/')
