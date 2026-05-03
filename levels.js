import { generateHardestLevel } from './generator.js';

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
 *   3 = ONEWAY_LEFT, 4 = ONEWAY_RIGHT, 5 = ONEWAY_UP, 6 = ONEWAY_DOWN
 */

export const SAMPLE_LEVELS = [
  generateHardestLevel(9, 9, { seed: 0, id: 1, candidates: 300 }),
];

// ── Hand-crafted 7×7 reference level (kept for reference) ───────────────────
//
// import { CellType } from './puzzle.js';
// const E = CellType.EMPTY, W = CellType.WALL;
//
//  S . . . . . .
//  W . . W . . .
//  . . . . . . W
//  . W . . . W .
//  . . . . . . .
//  . . W . . . W
//  . . . . . . G
//
// const sampleCells = new Uint8Array([
//   E,E,E,E,E,E,E,
//   W,E,E,W,E,E,E,
//   E,E,E,E,E,E,W,
//   E,W,E,E,E,W,E,
//   E,E,E,E,E,E,E,
//   E,E,W,E,E,E,W,
//   E,E,E,E,E,E,E,
// ]);
// { id:1, width:7, height:7, cells:sampleCells, start:{x:0,y:0}, goal:{x:6,y:6} }
