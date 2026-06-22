import { CellType } from './puzzle.js';

/**
 * Level format (what generateLevel emits, and what the game expects):
 *
 * {
 *   id:     string | number,
 *   width:  number,             // columns
 *   height: number,             // rows
 *   cells:  Uint8Array,         // flat row-major, length = width * height
 *   start:  { x: number, y: number },
 *   goal:   { x: number, y: number },
 * }
 *
 * CellType values (see puzzle.js):
 *   0 = EMPTY, 1 = WALL, 2 = STICKY,
 *   3 = ONEWAY_LEFT, 4 = ONEWAY_RIGHT, 5 = ONEWAY_UP, 6 = ONEWAY_DOWN,
 *   7 = CRUMBLE, 10 = TELEPORTER, 11 = HOOK
 */

const E = CellType.EMPTY;
const H = CellType.HOOK;

// All solution paths start with the dive move (DOWN from the boat at y=-1).
const DN = { dx:  0, dy:  1 };
const LT = { dx: -1, dy:  0 };
const RT = { dx:  1, dy:  0 };

// ── Level 1: "First Hook" ─────────────────────────────────────────────────────
//
// Dive into the hook at column 3, then slide left to the goal.
// No gears spent — the hook provides the free bend.
//
//  . . . . . . .   y=0  (hidden entry row)
//  . . . . . . .   y=1
//  . . . . . . .   y=2
//  G . . H . . .   y=3  ← HOOK at (3,3), GOAL at (0,3)
//  . . . . . . .   y=4
//  . . . . . . .   y=5
//
// Path: DOWN → HOOK(3,3) → LEFT → GOAL(0,3)
const hookLevel1 = {
  id: 1, seed: 0,
  width: 7, height: 6,
  cells: new Uint8Array([
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,H,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
  ]),
  start: { x: 3, y: -1 },
  goal:  { x: 0, y: 3 },
  effectiveCogs: 0,
  solutionPath: [DN, LT],
};

// ── Level 2: "Chain of Hooks" ─────────────────────────────────────────────────
//
// Two hooks, still no gears needed.
// Dive onto left hook, slide right to right hook (free bend), slide down to goal (free bend).
//
//  . . . . . . .   y=0  (hidden entry row)
//  . . . . . . .   y=1
//  H . . . . . H   y=2  ← HOOKs at (0,2) and (6,2)
//  . . . . . . .   y=3
//  . . . . . . .   y=4
//  . . . . . . G   y=5  ← GOAL at (6,5)
//  . . . . . . .   y=6
//
// Path: DOWN → HOOK(0,2) → RIGHT → HOOK(6,2) → DOWN → GOAL(6,5)
const hookLevel2 = {
  id: 2, seed: 0,
  width: 7, height: 7,
  cells: new Uint8Array([
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    H,E,E,E,E,E,H,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
  ]),
  start: { x: 0, y: -1 },
  goal:  { x: 6, y: 5 },
  effectiveCogs: 0,
  solutionPath: [DN, RT, DN],
};

// ── Level 3: "Last Gear" ──────────────────────────────────────────────────────
//
// One hook provides a free bend; the player must spend one real gear for the second bend.
//
//  . . . . . . .   y=0  (hidden entry row)
//  . . . . . . .   y=1
//  . . . H . . .   y=2  ← HOOK at (3,2)
//  . . . . . . .   y=3
//  . . . . . . .   y=4
//  . . . . . . .   y=5
//  G . . . . . .   y=6  ← GOAL at (0,6)
//
// Path: DOWN → HOOK(3,2) → LEFT (free) → (0,2) → DOWN (1 gear) → GOAL(0,6)
const hookLevel3 = {
  id: 3, seed: 0,
  width: 7, height: 7,
  cells: new Uint8Array([
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,H,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
    E,E,E,E,E,E,E,
  ]),
  start: { x: 3, y: -1 },
  goal:  { x: 0, y: 6 },
  effectiveCogs: 1,
  solutionPath: [DN, LT, DN],
};

export const SAMPLE_LEVELS = [hookLevel1, hookLevel2, hookLevel3];
