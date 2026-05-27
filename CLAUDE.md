# Slide Puzzle — context for AI debugging

This is a vanilla ES6 browser slide puzzle. The player (a diver) slides in 4
directions and stops at obstacles. A chain trails behind, stored as gear
waypoints. Levels are procedurally generated.

---

## Key files

| File | Role |
|---|---|
| `game.js` | Game state, move dispatch, win/dead-end logic, batch playthrough |
| `puzzle.js` | Pure physics: `slidePlayer`, BFS reachability (`canReachGoal`, `canReachAnyOf`), `buildToggleMap` |
| `solver.js` | Dijkstra pathfinder — finds minimum-gear move sequence |
| `renderer.js` | DOM/animation only, no game logic |
| `generator.js` | Procedural level generation (`generateHardestLevel`) |
| `levelConfig.js` | Stage progression and recipe lookup (`getRecipe`) |

---

## Cell types (puzzle.js `CellType`)

| Value | Name | Behaviour |
|---|---|---|
| 0 | EMPTY | slide through freely |
| 1 | WALL | stop *before* the cell |
| 2 | STICKY | stop *on* the cell |
| 3–6 | ONEWAY_LEFT/RIGHT/UP/DOWN | passable only from the matching direction; otherwise stop before |
| 7 | CRUMBLE | acts like WALL until the player stops against it (toggle activates), then passable |
| 8 | KEY | stop on it, collect it (activates paired door toggle) |
| 9 | DOOR | blocks like WALL until paired KEY's toggle is active |

ASCII grid symbols in console output: `. # S ← → ↑ ↓ c K D`, `G` = goal, `^` = boat entry column.

---

## Chain / gear system — the most complex part

- The chain runs from a **boat** above the grid (`level.start`, y = -1) through
  a series of **gear waypoints** to the player's current position.
- A gear is placed at the player's current cell whenever they **change direction
  (bend)**. Cost: 1 gear from `gearsLeft`.
- Moving in a **straight continuation** of the last segment pops the last gear
  (free refund).
- Reaching a **previously visited gear cell** retracts the chain back to that
  waypoint and refunds all gears between.
- Entering the **boat** (sliding back to y = -1) clears all gears.
- The chain has **no length limit** — players can slide as far as the physics allow.
- **`gearsLeft`** = remaining bend budget. Running out while trying to place a
  gear causes a dead-end.

---

## Solver (solver.js) — known limitations

The solver uses **Dijkstra** with cost = gears used (bends made).
It tracks `(playerPos, worldState, gearsUsed, prevDir)`.

**What it does NOT model:**
- Gear waypoint positions — it cannot simulate backtracking that would free
  gear budget for later moves.
- One-way double-press backtracking.

**Consequence:** The solver may miss paths that require intentional backtracking
to a gear waypoint (which refunds gears) before advancing again.

---

## Batch playthrough — how to use

Add `?debug` to the URL. A **"test ∞"** button appears in the toolbar (runs until
stopped). Levels are generated sequentially from the same seed/recipe sequence
as the game (seed starts at 300, increments by `recipe.candidates` each level).
**Note:** uses `generateFallback` (20 candidates) not the worker (up to 300),
so generated levels may be easier variants of what the player actually sees.

The playthrough per level:
1. Generates and loads the level, waits for the initial slide-in.
2. Runs the solver. If no path → logs failure immediately.
3. Runs auto-play with `_batchBypassConstraints = true` (chain/gear limits are
   tracked but not enforced, so the player can still win even if budgets are wrong).
4. On win: checks whether gears were exactly used up. Logs a warning if
   the gear budget was over- or under-allocated.
5. On dead-end or path-exhausted: logs a failure.
6. Prints `✓` for clean passes, skips logging them.

### Failure reasons

| Reason | Meaning |
|---|---|
| `solver found no path` | Dijkstra explored the full state space and found no route. Level may require backtracking through gear waypoints (which the solver can't model). |
| `dead-end` | Solver found a path and executed it, but the game's reachability BFS declared the player stuck. The planned moves moved the player into a position where neither the goal nor any uncollected key is reachable. |
| `solver path exhausted without reaching goal` | Solver's moves all executed but the player never landed on the goal. Most likely cause: gear budget was exhausted mid-path. |

---

## Interpreting console failure output

When a level fails the console logs:

```
Level N — <reason>
  Seed / Size
  Boat entry (y=-1)                  ← level.start, ABOVE the grid — NOT where moves begin
  Solver started at: {x, y}         ← where the player landed after auto-slide from boat
                                        ALL planned moves start from here
  Gear budget
  Player stopped at: {x, y}         ← position when failure was detected
                                        for "path exhausted": after ALL planned moves ran
                                        for "dead-end": when the game's BFS declared stuck
  World state: 00000101              ← bitmask; bit N set = toggle N is active
                                        (crumbles broken + keys collected, assigned in
                                         flat scan order by buildToggleMap in puzzle.js)
  Gears left / total
  Gear waypoints at failure          ← the bend positions in the chain, boat→player order
  Planned moves (N): → ↓ ← ↑ …      ← full solver sequence starting from "Solver started at"
  Grid: (ASCII)
  Level JSON: {...}                  ← complete level data for exact reproduction
```

### Critical distinctions

**"Boat entry" vs "Solver started at"**: The boat (`level.start`, y = -1) is
always above the grid. When a level loads the player auto-slides down and lands
somewhere in the grid. The solver runs *from that landed position*. "Planned
moves" begin at "Solver started at", not at the boat.

**Zero-movement slides (crumble bounce)**: When the player slides into an
intact CRUMBLE, `slidePlayer` returns the *same position* but sets `crumble` in
the result. The game activates the toggle (worldState changes) but the player
doesn't move. In the *next* move the crumble is broken and passable. The solver
models this correctly — a no-move state with changed worldState is a valid
BFS/Dijkstra node. Whether it places a gear depends on whether `prevDir`
changes, which the solver does *not* track.

**Gear waypoints**: Each direction-change (bend) places a gear at the player's
current position and costs 1 from `gearsLeft`. The "Gear waypoints at failure"
list shows exactly where the bends are.

**To reproduce a specific level in the browser**: open `index.html?debug`, use
the Skip button to reach the failing level number, then press **Auto-play** to
watch the solver's attempt live. Or paste the Level JSON into the DevTools
console and call `loadLevel` directly (it's not exported, so easiest to use the
batch test with a count matching that level number).

**Gen visualiser** (`gen` button in the toolbar): shows the BFS carving process
step-by-step with the optimal path overlaid in pink. Enable **universes** mode
to see all worldState variants side-by-side. The **"path only"** checkbox
(visible in universes mode) filters the view to only the universes the optimal
path actually passes through — useful for verifying which toggles matter for
the solution.

---


## Known failure modes (ranked most→least common)

1. **Solver misses backtrack paths** — some levels may only be solvable by
   intentionally backtracking to a gear (which refunds it), then advancing
   again. The solver never backtracks and may return `null` for these.

2. **Gear budget exhaustion mid-path** — the solver tracks `gearsLeft` and
   prunes branches that exceed it, but it doesn't model the gear *refund* from
   backtracking through a waypoint. It may declare no path when one exists via
   a backtrack-then-advance sequence.

---

## Asking for help debugging a failure

Paste the full console group output (everything between the red header and the
closing `}` of the Level JSON). The most useful fields are:

- **Reason** — which failure type
- **Planned moves** — where the solver intended to go
- **Player stopped at** — where the game actually ended up
- **Chain used / limit** — whether chain was a constraint
- **Grid** — the level layout
- **Level JSON** — the complete level data for exact reproduction
