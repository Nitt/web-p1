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
| `solver.js` | Dijkstra pathfinder — finds minimum-chain-length move sequence |
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
- **`chainLengthTotal`** = maximum total Manhattan-distance length of the chain
  from boat to player. Enforced per-move: if a slide would exceed the remaining
  budget (`chainAvail = chainLengthTotal − _chainLengthUsed()`), `slidePlayer`
  is called again with `maxSlideLength = chainAvail` so the player stops early.
- **`gearsLeft`** = remaining bend budget. Running out while trying to place a
  gear causes a dead-end.

---

## Solver (solver.js) — known limitations

The solver uses **Dijkstra** with cost = total cells slid (chain length used).
It simulates each move with `slidePlayer(..., chainAvail)` to respect the chain
cap, mirroring `_executeMove`. It tracks `(playerPos, worldState)` only.

**What it does NOT model:**
- Gear waypoint positions — it cannot simulate backtracking that would shorten
  the chain and free budget for later moves.
- `prevDir` — it doesn't know whether the next move is a bend or straight, so
  it can't predict exact gear consumption.
- One-way double-press backtracking.

**Consequence:** The solver's `chainAvail` at each step is `chainLengthTotal −
totalCellsTraveled`. In reality, `_chainLengthUsed()` measures the current
chain length (which can be *shorter* than total traveled if the player
backtracked). So the solver can be overly pessimistic (thinks chain is fuller
than it is) OR overly optimistic (if actual gear waypoints make the chain
longer than a straight path would be). A path the solver finds may fail in the
game if the gear waypoints push the actual chain length over budget.

---

## Batch playthrough — how to use

Add `?debug` to the URL. A "test 50" button appears in the toolbar.

The playthrough:
1. Pre-generates levels 1–50 using the same seed/recipe sequence as the game
   (seed starts at 300, increments by `recipe.candidates` each level).
   **Note:** uses `generateFallback` (20 candidates) not the worker (up to 300),
   so generated levels may be easier variants of what the player actually saw.
2. Loads each level, waits for the initial slide-in.
3. Runs the solver. If no path → logs failure immediately.
4. Runs auto-play. Waits for win, dead-end, or moves-exhausted.
5. Logs failures only; prints `✓` for successes.

### Failure reasons

| Reason | Meaning |
|---|---|
| `solver found no path` | Dijkstra explored the full state space and found no route. Level is likely genuinely unsolvable with the given chain limit, OR requires backtracking the solver can't model. |
| `dead-end` | Solver found a path and executed it, but the game's reachability BFS (which *does* account for gears/backtracking from chain waypoints) declared the player stuck. The planned moves moved the player into a position where neither the goal nor any uncollected key is reachable. |
| `solver path exhausted without reaching goal (chain mismatch?)` | Solver's moves all executed but the player never landed on the goal. Most likely cause: a slide was capped shorter by `chainAvail` than the solver expected, so the player stopped at the wrong cell and subsequent moves followed a wrong path. |

---

## Interpreting console failure output

When a level fails the console logs:

```
Level N — <reason>
  Seed / Size / Start / Goal
  Chain limit / Gear budget
  Player stopped at: {x, y}         ← where the player is when failure detected
  World state: 00000101              ← bitmask; bit N set = toggle N is active
  Chain used / Chain limit           ← how much chain was consumed
  Gears left / total
  Planned moves: → ↓ ← ↑ ...        ← the full solver solution
  Grid: (ASCII)
  Level JSON: {...}                  ← paste this to reproduce the exact level
```

**To reproduce a specific level in the browser** — paste into the DevTools console:

```js
import('./game.js').then(g => {
  import('./generator.js').then(({ generateLevel }) => {
    // or build the level object directly from the JSON in the failure log
  });
});
```

Easier: open `index.html?debug`, click through to the failing level number, then
use the **Auto-play** button to watch the solver's attempt live.

---

## Known hypotheses for level failures

1. **Chain length one cell too short** — observed on level 24. The generated
   chain limit (`effectiveChainLength`) may not account for the gear waypoints
   that extend the physical chain beyond the Manhattan-distance path length.
   The solver finds a path that fits in `chainLengthTotal` cells of travel, but
   the actual chain (routed through gear waypoints) is longer.

2. **Solver misses backtrack paths** — some levels may only be solvable by
   intentionally backtracking to a gear to shorten the chain, then advancing
   again. The solver never backtracks and would return `null` for these.

3. **Gear budget exhaustion mid-path** — if the shortest-chain-length path
   requires many direction changes, it may exhaust `gearsLeft` before reaching
   the goal. The solver doesn't check gear budget.

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
