/**
 * Level progression configuration.
 *
 * Each stage covers levels from (previous stage's untilLevel + 1) up to
 * and including `untilLevel` (use Infinity for the final, open-ended stage).
 *
 * ── Stage fields ──────────────────────────────────────────────────────────
 *
 * untilLevel      number | Infinity
 *   Last level (inclusive) this stage applies to.
 *
 * weights         object
 *   Probability weights for cell types when carving the maze.
 *   Absent keys default to 0.  `empty` is the baseline and is always present.
 *   Relative values — a cell type whose weight equals `empty` is as common as
 *   plain empty cells.  Lower values = the type appears more rarely.
 *
 * keyDoor         false | true | { minInterval, maxInterval }
 *   false  — never place a key/door pair.
 *   true   — always attempt to place one.
 *   object — place one randomly, with probability rising linearly from 0 at
 *            minInterval levels-since-last to 1 at maxInterval; forced at max.
 *
 * difficultyTarget  number | null
 *   number — pick the generated candidate whose goalDifficulty is closest to
 *            this value (measured as absolute distance).
 *   null   — pick the hardest candidate (original behaviour).
 *
 * candidates      number
 *   How many random seeds to evaluate before picking the best one.
 *   Higher = better quality but more CPU work (done off-thread).
 */
export const PROGRESSION = [
  {
    // ── Stage 1: introduction ── sticky only, very easy
    untilLevel:       3,
    weights:          { sticky: 0.18, block: 0.00, oneway: 0.00, crumble: 0.00, empty: 1.0 },
    keyDoor:          false,
    difficultyTarget: 6,
    candidates:       80,
  },
  {
    // ── Stage 2: walls enter ── small mazes with dead-ends
    untilLevel:       7,
    weights:          { sticky: 0.10, block: 0.10, oneway: 0.00, crumble: 0.00, empty: 1.0 },
    keyDoor:          false,
    difficultyTarget: 13,
    candidates:       120,
  },
  {
    // ── Stage 3: one-ways enter ── directional constraints
    untilLevel:       12,
    weights:          { sticky: 0.08, block: 0.10, oneway: 0.04, crumble: 0.00, empty: 1.0 },
    keyDoor:          false,
    difficultyTarget: 20,
    candidates:       180,
  },
  {
    // ── Stage 4: crumble enters ── topology-changing blocks
    untilLevel:       17,
    weights:          { sticky: 0.06, block: 0.10, oneway: 0.03, crumble: 0.06, empty: 1.0 },
    keyDoor:          false,
    difficultyTarget: 26,
    candidates:       240,
  },
  {
    // ── Stage 5: everything ── full chaos, key/door cycles
    untilLevel:       Infinity,
    weights:          { sticky: 0.06, block: 0.10, oneway: 0.02, crumble: 0.07, empty: 1.0 },
    keyDoor:          { minInterval: 4, maxInterval: 15 },
    difficultyTarget: null,   // pick hardest
    candidates:       300,
  },
];

// ── Recipe resolver ───────────────────────────────────────────────────────────

/**
 * Return the generation recipe for a given level.
 *
 * @param {number} levelIndex        - 1-indexed level number being generated
 * @param {number} levelsSinceKeyDoor - levels elapsed since the last key/door level
 *                                     (0 = the immediately previous level had one)
 * @returns {{ weights, useKeyDoor: boolean, difficultyTarget, candidates }}
 */
export function getRecipe(levelIndex, levelsSinceKeyDoor) {
  const stage = PROGRESSION.find(s => levelIndex <= s.untilLevel)
    ?? PROGRESSION[PROGRESSION.length - 1];

  let useKeyDoor = false;
  if (stage.keyDoor === true) {
    useKeyDoor = true;
  } else if (stage.keyDoor && typeof stage.keyDoor === 'object') {
    const { minInterval, maxInterval } = stage.keyDoor;
    if (levelsSinceKeyDoor >= maxInterval) {
      // Too long without one — force it.
      useKeyDoor = true;
    } else if (levelsSinceKeyDoor >= minInterval) {
      // Probability rises linearly from 0→1 between min and max interval.
      const t = (levelsSinceKeyDoor - minInterval) / (maxInterval - minInterval);
      useKeyDoor = Math.random() < t;
    }
  }

  return {
    weights:          stage.weights,
    useKeyDoor,
    difficultyTarget: stage.difficultyTarget,
    candidates:       stage.candidates,
  };
}
