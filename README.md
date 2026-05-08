# Slide Puzzle

A water-themed procedurally generated puzzle game. The player (a diver) drops from a boat into an underwater maze and must slide to the goal using a limited gear budget.

## How to Run

No build step required. Open `index.html` directly in a browser — all code is vanilla ES6 modules with zero external dependencies.

## How to Play

- Use **arrow keys** (desktop) or **swipe/d-pad** (mobile) to move
- The player slides continuously in the chosen direction until hitting a wall or stopping cell
- You have a **gear budget** equal to the minimum number of moves needed to solve the level
- Each new position you land on costs 1 gear; revisiting an old position reclaims gears
- Reach the **goal** (treasure chest) before running out of gears

### Cell Types

| Cell | Behavior |
|------|----------|
| Empty | Slides through freely |
| Wall | Stops movement before it |
| Sticky | Player lands and stops on it |
| One-way (←→↑↓) | Only passable from the indicated direction |
| Crumble | Solid on first approach; breaks and becomes passable after |
| Key | Player stops to collect it; unlocks paired door |
| Door | Blocks until the paired key is collected |

### Gear Chain

The gear chain is a visual budget tracker — each link represents a waypoint visited. When you revisit an old waypoint the chain shortens and gears are refunded. If you get completely stuck the game detects it and flags a dead end.

## Project Structure

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a full breakdown of all modules and how they interact.

See [`GENERATOR.md`](GENERATOR.md) for a deep dive into the procedural level generation algorithm.

## Debug Mode

Press **D** (or the debug button) to toggle debug overlay, which shows cell coordinates, BFS depths, difficulty scores, and which directions the generator explored from each cell.

The debug panel also includes a step-by-step carving visualizer with seed/size controls.

## Progression

Levels ramp up across 5 stages before entering an endless mode:

| Stage | New Feature |
|-------|------------|
| Tutorial | Basic movement |
| Introduction | Sticky cells |
| Walls Enter | Wall walls |
| One-ways Enter | Directional one-way cells |
| Crumbles Enter | Crumbling blocks |
| Endless | Full feature set + key/door pairs |

Difficulty targets are defined per stage in `levelConfig.js`. The generator evaluates multiple candidate seeds and picks the one closest to the target difficulty score.
