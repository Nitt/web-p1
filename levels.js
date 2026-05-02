import { CellType } from './puzzle.js';

const E = CellType.EMPTY;
const W = CellType.WALL;

/**
 * Level format — what the level generator should emit:
 *
 * {
 *   id:     string | number,
 *   width:  number,           // columns
 *   height: number,           // rows
 *   cells:  Uint8Array,       // flat row-major, length = width * height
 *   start:  { x: number, y: number },   // 0-indexed, top-left origin
 *   goal:   { x: number, y: number },
 * }
 */

// 7×7 sample level (row-major, top-left = (0,0))
// S = start (0,0)  G = goal (6,6)
//
//  S . . . . . .
//  W . . W . . .
//  . . . . . . W
//  . W . . . W .
//  . . . . . . .
//  . . W . . . W
//  . . . . . . G

const sampleCells = new Uint8Array([
  E, E, E, E, E, E, E,  // row 0
  W, E, E, W, E, E, E,  // row 1
  E, E, E, E, E, E, W,  // row 2
  E, W, E, E, E, W, E,  // row 3
  E, E, E, E, E, E, E,  // row 4
  E, E, W, E, E, E, W,  // row 5
  E, E, E, E, E, E, E,  // row 6
]);

export const SAMPLE_LEVELS = [
  {
    id: 1,
    width: 7,
    height: 7,
    cells: sampleCells,
    start: { x: 0, y: 0 },
    goal:  { x: 6, y: 6 },
  },
];
