# Architecture

## Module Map

```
index.html
  └── game.js            ← main orchestrator
       ├── puzzle.js      ← physics & reachability
       ├── renderer.js    ← DOM rendering & animation
       ├── input.js       ← keyboard / touch / d-pad
       ├── sounds.js      ← procedural audio
       ├── generator.js   ← level generation
       ├── levelConfig.js ← difficulty stages
       └── levels.js      ← sample starter levels

levelWorker.js            ← Web Worker wrapping generator.js
random.js                 ← seeded RNG (used only by generator.js)
```

No external dependencies. All modules are plain ES6 with no bundler.

---

## Module Responsibilities

### `game.js`
Central state owner. Owns the `state` object (see below), drives the game loop, and coordinates all other modules. Key responsibilities:
- Level loading and progression
- Handling player input via `handleMove()`
- Calling `slidePlayer()` and updating state
- Triggering animations and sounds
- Detecting win/dead-end conditions
- Scheduling background level pre-generation via the Web Worker

### `puzzle.js`
Pure game logic — no DOM access, no side effects. Exports:
- `slidePlayer(level, pos, dx, dy, toggleMap, worldState, gearSet)` — simulates a single slide, returns final position and metadata (crumble/key/oneway events)
- `canReachGoal(level, pos, worldState, toggleMap, doorReqs)` — BFS check: can the player still reach the goal from current state?
- `CellType` enum and `isOneway()` helper

### `renderer.js`
All visual output. Builds the CSS grid DOM, places overlays, animates the player, draws the gear chain SVG. Never mutates game state — it only reads what `game.js` passes to it. Key exports:
- `buildGrid(level)` — creates cell `<div>`s with correct `data-type`/`data-dir` attributes
- `animatePlayer(from, to, ...)` — frame-by-frame player movement (`requestAnimationFrame`)
- `drawChain(gears, gearsLeft, ...)` — redraws gear chain polyline, gear icons, and link indicators
- `repositionOverlays()` — called on resize to keep overlays aligned with the grid

### `generator.js`
Procedural level factory. See [`GENERATOR.md`](GENERATOR.md) for full details. Key exports:
- `generateLevel(width, height, opts)` — single level from a seed
- `generateHardestLevel(width, height, opts)` — evaluates `candidates` seeds, returns the one closest to `difficultyTarget`
- `DIFFICULTY_WEIGHTS` — exported so `levelConfig.js` can reason about difficulty tuning
- `computeStepAnalysis(step, ...)` — used by the debug visualizer to compute depths/difficulties for a mid-generation snapshot

### `input.js`
Normalizes all input sources (keyboard arrows, touch swipes, mouse drag, on-screen d-pad buttons) into `handleMove(dx, dy)` calls. Configured once via `initInput(gridEl, dpadEl, handleMove)`.

### `sounds.js`
Nine procedural sound effects built with Web Audio API (`OscillatorNode`, `GainNode`, `BiquadFilterNode`, `AudioBufferSourceNode`). All are fire-and-forget. Lazy-initializes `AudioContext` on first call to avoid autoplay restrictions.

### `levelConfig.js`
Defines the 5-stage progression. Each stage specifies:
- Number of levels in the stage
- Cell type probability weights (controls what types the generator carves)
- Difficulty target range
- Number of candidate seeds to evaluate
- Whether to enable key/door pairs

Exports `getRecipe(levelIndex, levelsSinceKeyDoor)` which returns the generation parameters for a given level number.

### `random.js`
Minimal 14-line seeded LCG (linear congruential generator). `makeRng(seed)` returns a `() => [0,1)` function. Used exclusively by `generator.js` so levels are fully deterministic given the same seed.

### `levelWorker.js`
Thin Web Worker wrapper around `generateHardestLevel`. `game.js` posts a message with generation params; the worker replies with the completed level object. Prevents generation (which can take tens of milliseconds) from blocking the main thread.

---

## Game State

All mutable game state lives in a single `state` object in `game.js`:

```js
{
  level,              // Current level object from generator
  playerPos,          // {x, y} — y=-1 means at boat (above grid)
  isMoving,           // true during animation; queues input
  won,                // true after reaching goal
  queuedMove,         // {dx, dy} buffered during animation window
  gears,              // [{x,y}, ...] waypoints visited (chain)
  gearsLeft,          // remaining gear budget
  totalGears,         // starting budget (= BFS depth of goal)
  worldState,         // 31-bit bitmask — which toggles are active
  toggleMap,          // Map<flatIdx, toggleIdx> for crumbles & keys
  nextId, nextSeed,   // pre-generated next level params
  levelIndex,         // 1-indexed progression counter
  levelsSinceKeyDoor, // used by levelConfig to pace key/door pairs
  pendingOnewayBreak, // state for double-tap one-way backtrack
}
```

---

## Level Object Shape

Produced by `generator.js`, consumed by `game.js`, `puzzle.js`, and `renderer.js`:

```js
{
  id,                    // number
  width, height,         // inner grid dimensions (no border padding)
  cells,                 // Uint8Array, row-major, values are CellType ints
  start,                 // {x, y}  — y=-1 means boat entry above grid
  goal,                  // {x, y}
  depths,                // Int16Array — BFS move-count to each cell (-1 = unreachable)
  difficulties,          // Float32Array — Dijkstra difficulty score per cell (-1 = unreachable)
  goalDifficulty,        // float — difficulties[goal]
  doorRequirements,      // Map<flatIdx, toggleIdx>
  seed,                  // number — for reproducibility
  visitedDirs,           // Map<flatIdx, Set<dirKey>> — generator exploration trace (for debug)
  weights,               // cell-type probability weights used during generation
}
```

---

## Toggle / World State System

Crumbles, keys, and doors all use a shared **toggle bitmask** (`worldState`):

- On level load, `buildToggleMap()` scans `cells` and assigns a `toggleIdx` (0–30) to every `CRUMBLE` and `KEY` cell in flat-index order.
- `worldState` is a 31-bit integer. Bit `toggleIdx` is `0` = intact, `1` = activated.
- **CRUMBLE activation**: player stops before it → `worldState |= 1 << toggleIdx` → cell now passable.
- **KEY activation**: player lands on it → `worldState |= 1 << toggleIdx` → paired door(s) unlock.
- Both `puzzle.js` and `generator.js` use this same logic, so generation and gameplay are consistent.

---

## Rendering Pipeline

1. `buildGrid()` creates one `<div class="cell">` per tile, styled via `data-type` and `data-dir` CSS attributes. The grid uses CSS custom properties `--cols` and `--rows` to set up a `display: grid` layout.
2. Player and goal are absolutely positioned overlays, not grid cells, so they can animate freely.
3. The chain is a single `<svg>` overlay with a `<polyline>` for the path and individual `<circle>`/`<path>` elements for gear shapes and link indicators.
4. The waterline and boat are static SVG overlays positioned above the grid row for `y = 0`.
5. On resize, `repositionOverlays()` recalculates pixel positions from the grid's `getBoundingClientRect`.

---

## Input Handling

All input ultimately calls `handleMove(dx, dy)` in `game.js`:

| Source | Mechanism |
|--------|-----------|
| Keyboard | `keydown` → arrow/WASD → `(dx, dy)` |
| Touch swipe | `touchstart`/`touchend` delta → direction → `(dx, dy)` |
| Mouse drag | `pointerdown`/`pointerup` delta → direction |
| D-pad buttons | `click` on directional `<button>` elements |

During an animation, moves are buffered into `state.queuedMove` and replayed within a 300ms window after the animation ends.
