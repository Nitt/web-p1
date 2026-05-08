# Level Generator

`generator.js` produces procedural puzzle levels that are always solvable and physically consistent with the game's slide mechanics.

---

## High-Level Overview

Generation happens in three phases:

1. **Carving** — BFS exploration of the grid, deciding what each cell becomes
2. **Analysis** — BFS + Dijkstra over the carved grid to find depths and difficulty scores
3. **Goal & key/door placement** — pick the hardest reachable cell as goal; optionally gate it behind a key/door pair

---

## Phase 1: Carving

### Grid Setup

The grid is padded by one cell of `BLOCK` on all sides, so the inner `width × height` play area is always fully bordered. Cells start as `UNTOUCHED` (unassigned).

An **entry tunnel** is forced at the top-center: two cells are set to `EMPTY` so the player always slides down two cells before encountering a decision point. All other top-row cells are walled off to prevent unintended lateral sliding.

### BFS Carving Loop

The outer loop is a **FIFO queue** (`branchQueue.shift()` = BFS order). Each queue entry is a grid position `{x, y}` that has become a landing point and needs its four directions explored.

Processing a queue entry calls `carve(dirKey, x, y)` in all four directions.

### `carve(dirKey, x, y)`

Simulates a player sliding from `(x, y)` in direction `dirKey` and decides what the next cell becomes. Uses `visitedDirs` (a `Map<cellIndex, Set<dirKey>>`) to avoid re-exploring the same direction from the same cell.

When the next cell is `UNTOUCHED`, a random type is chosen (weighted by stage config):

| Chosen Type | Action |
|-------------|--------|
| `empty` | Mark cell `EMPTY`, recurse in same direction (slide continues) |
| `oneway` | Mark cell `ONEWAY`, recurse in same direction (player slides through) |
| `block` | Mark cell `BLOCK`, enqueue `(x, y)` for lateral exploration |
| `sticky` | Mark cell `STICKY`, enqueue `(nx, ny)` — player lands here |
| `crumble` | Mark cell `CRUMBLE`, enqueue `(x, y)` AND a post-crumble continuation (see below) |

When the next cell is already carved, `carve` handles it according to slide physics: continue through `EMPTY`/passable cells, stop and re-enqueue at `BLOCK`/`STICKY`/`ONEWAY` (blocked direction), etc.

### Key Insight: Physics-Consistent Carving

`carve` mirrors `slidePlayer()` in `puzzle.js`. Every path the carver creates is a path the player can actually traverse. This guarantees all carved cells are reachable and no impossible moves are implied.

### Crumble: Parallel Universes

Crumbles are interesting because the same cell behaves differently before and after breaking. The carver handles this by enqueuing **two** continuations when it places a crumble:

1. **Stop before crumble** — the normal stop branch, enqueued for lateral BFS exploration from `(x, y)`
2. **Post-crumble continuation** — re-queued as `{ x, y, resumeDir: dirKey }`. When processed, the crumble's `visitedDir` entry is deleted so `carve` can slide through it again, now treating it as passable

This ensures the level is carve-complete for both the "crumble intact" and "crumble broken" states.

---

## Phase 2: Analysis

Run after carving completes. Two separate passes over the final grid:

### Pass 1 — BFS for Move Depths

Standard BFS where each **slide** (regardless of how many cells it covers) counts as 1 move. Every cell touched by a slide at depth `d` is recorded at depth `d`. The `depths` array in the returned level object is the result.

State includes `(position, incomingDirection, worldState)` so one-way interactions are correctly handled from every approach angle, and crumble/key toggle states are tracked.

### Pass 2 — Dijkstra for Difficulty

Same traversal as BFS but with variable edge costs defined by `DIFFICULTY_WEIGHTS`:

| Weight | Value | When Applied |
|--------|-------|-------------|
| `BASE_MOVE` | 1.0 | Every slide |
| `SLIDE_LENGTH` | 0.15 | Per extra cell beyond the first |
| `STICKY` | 0.5 | Landing on a sticky cell |
| `ONEWAY_TRAVERSE` | 1.0 | Passing through a one-way (correct direction) |
| `ONEWAY_BLOCKED` | 2.5 | Stopped by a one-way (wrong direction) |
| `CRUMBLE` | 1.5 | Stopped by a crumble (first visit) |
| `CRUMBLE_TRAVERSE` | 3.0 | Sliding through a previously broken crumble |
| `KEY` | 2.5 | Landing to collect a key |
| `DOOR_TRAVERSE` | 1.0 | Sliding through an open door |
| `DOOR_LOCKED` | 3.5 | Stopped by a locked door |
| `CHAIN_CROSSING` | 3.0 | Optimal path requires revisiting a waypoint |

The `difficulties` array in the level object is the result.

### Chain Crossing Detection

After Dijkstra, for each candidate goal cell the carver traces the parent-pointer chain back to start. If any landing position appears twice in the chain (a revisit is required on the optimal path), `CHAIN_CROSSING` is added to that cell's difficulty score.

---

## Phase 3: Goal and Key/Door Placement

### Goal Selection

The goal is the non-wall, non-toggle, non-oneway reachable cell with the **highest difficulty score**. Ties are broken by Manhattan distance from start (farther = preferred).

### Key/Door Placement (`_tryPlaceKeyDoor`)

Optional, enabled by stage config. Attempts to gate the selected goal behind a locked door:

1. Compute all reachable cells from start (BFS landing positions)
2. For each candidate empty cell, temporarily wall it off and re-run BFS
3. If the goal becomes unreachable but other cells remain reachable, it's a valid door position
4. Pick a random valid door position; pick a random empty cell on the reachable (key) side as the key position
5. Place `KEY` and `DOOR` in the cell array; set `doorRequirements` map

If no valid door placement exists, the level is returned without key/door.

---

## Difficulty Targeting (`generateHardestLevel`)

Instead of generating one level, this function generates `candidates` consecutive seeds and returns the one with a `goalDifficulty` closest to `difficultyTarget` (or the hardest of all, if no target is given).

Stage configs in `levelConfig.js` set `difficultyTarget` and `candidates` per stage to control the difficulty ramp.

---

## Exported API

```js
generateLevel(width, height, opts)
// → level object (see ARCHITECTURE.md for shape)

generateHardestLevel(width, height, opts)
// → level object (best of `candidates` seeds)

computeStepAnalysis(step, width, height, start)
// → { depths, difficulties } for a mid-generation snapshot (debug visualizer)

DIFFICULTY_WEIGHTS
// → exported object for inspection / tuning
```

---

## Debug Visualizer

Passing `_steps: []` to `generateLevel` fills the array with grid snapshots after each carve operation. The debug panel in `index.html` uses `computeStepAnalysis` to render depths and difficulties at each step, letting you watch the BFS carver explore the grid in real time.
