/**
 * Level progression configuration.
 *
 * ── Stage fields ──────────────────────────────────────────────────────────
 *
 * levels          number | Infinity
 *   How many levels this stage spans.  Use Infinity for the final open-ended
 *   stage.
 *
 * weights         object
 *   Probability weights for cell types when carving the maze.
 *   Absent keys default to 0.  `empty` is the baseline and is always present.
 *   Relative values — a cell type whose weight equals `empty` is as common as
 *   plain empty cells.  Lower values = the type appears more rarely.
 *
 * difficultyTarget  [from, to] | null
 *   [from, to] — linearly interpolate from `from` (first level of stage) to
 *                `to` (last level of stage).  Each individual level gets the
 *                closest-matching candidate.
 *   null       — pick the hardest candidate (no difficulty targeting).
 *
 * candidates      number
 *   How many random seeds to evaluate before picking the best one.
 *   Higher = better quality but more CPU work (done off-thread).
 *
 * entrySlide      { type, dist } | { type, minDist, maxDist } | null
 *   null        — no forced block in the entry column (default).
 *   { type, dist }             — place a block of `type` at exact `dist` from
 *                                the boat (1-indexed; minimum 2).
 *   { type, minDist, maxDist } — pick a random distance in [minDist, maxDist].
 *   Supported types: 'sticky', 'crumble', 'block'.
 *   All cells between the entry tunnel and the forced block are kept empty so
 *   the player always reaches it on the initial auto-slide.
 *   Useful for tutorial levels that must teach a specific mechanic on entry.
 */
export const PROGRESSION = [
  {
    // ── first level ── simple and quick to load
    levels:           1,
    weights:          { sticky: 0.08, block: 0.00, oneway: 0.00, crumble: 0.00, empty: 1.0 },
    difficultyTarget: [1, 1],
    candidates:       10,
    playerGears:      3,
  },
  {
    // ── introduction ── sticky only, gentle ramp
    levels:           3,
    weights:          { sticky: 0.18, block: 0.00, oneway: 0.00, crumble: 0.00, empty: 1.0 },
    difficultyTarget: [4, 8],
    candidates:       20,
    playerGears:      3,
  },
  {
    // ── walls enter ── dead-ends and corridors
    levels:           4,
    weights:          { sticky: 0.10, block: 0.10, oneway: 0.00, crumble: 0.00, empty: 1.0 },
    difficultyTarget: [9, 16],
    candidates:       25,
    playerGears:      4,
  },
  {
    // ── one-ways enter ── directional constraints
    levels:           5,
    weights:          { sticky: 0.08, block: 0.10, oneway: 0.04, crumble: 0.00, empty: 1.0 },
    difficultyTarget: [16, 24],
    candidates:       30,
    playerGears:      5,
  },
  {
    // ── crumble enters ── topology-changing blocks
    levels:           5,
    weights:          { sticky: 0.06, block: 0.10, oneway: 0.03, crumble: 0.06, empty: 1.0 },
    useTeleporter:    false,
    difficultyTarget: [22, 30],
    candidates:       35,
    playerGears:      5,
  },
  {
    // ── everything ── full chaos
    levels:           Infinity,
    weights:          { sticky: 0.06, block: 0.10, oneway: 0.02, crumble: 0.07, empty: 1.0 },
    useTeleporter:    true,
    difficultyTarget: null,   // pick hardest
    candidates:       40,
    playerGears:      6,
    maxUniverseBits:  5,      // cap crumbles at 5 total toggles (2^5 = 32 universes max)
  },
];

// ── Recipe resolver ───────────────────────────────────────────────────────────

/**
 * Return the generation recipe for a given level.
 *
 * @param {number} levelIndex - 1-indexed level number being generated
 * @returns {{ weights, useTeleporter: boolean, difficultyTarget: number|null, candidates }}
 */
export function getRecipe(levelIndex) {
  // Walk stages to find which one `levelIndex` falls in, and where within it.
  let stageStart = 1;  // first level of the current stage (1-indexed)
  let stage = PROGRESSION[PROGRESSION.length - 1];
  for (const s of PROGRESSION) {
    const stageEnd = s.levels === Infinity ? Infinity : stageStart + s.levels - 1;
    if (levelIndex <= stageEnd) {
      stage = s;
      break;
    }
    stageStart += s.levels;
  }

  // Interpolate the difficulty target across the stage.
  let difficultyTarget = null;
  if (Array.isArray(stage.difficultyTarget)) {
    const [from, to] = stage.difficultyTarget;
    if (stage.levels <= 1) {
      difficultyTarget = from;
    } else {
      const t = Math.min(1, (levelIndex - stageStart) / (stage.levels - 1));
      difficultyTarget = from + (to - from) * t;
    }
  }

  return {
    weights:         stage.weights,
    useTeleporter:   stage.useTeleporter ?? false,
    difficultyTarget,
    candidates:      stage.candidates,
    entrySlide:      stage.entrySlide ?? null,
    playerGears:     stage.playerGears,
    maxUniverseBits: stage.maxUniverseBits ?? Infinity,
  };
}
