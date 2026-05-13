# Ideas & Improvements

A running list of things to explore or improve. Update with findings, or remove when done.

---

## Rules for AI

Guidelines for working through this list:

- **Pick one thing at a time.** Before starting, scan all items and identify the best candidate: the one with the highest impact, the fewest dependencies on other unfinished ideas, and no risk of conflicting with work already in progress.
- **Prefer foundational work first.** If an idea would make several other ideas easier or safer to implement, do that one first.
- **Don't start something that would be invalidated by another open idea.** If two items are in tension, flag it and ask before picking.
- **Update the list as you go.** Add findings, open questions, or sub-tasks under the item being worked on. Remove the item when it's fully done.
- **Don't batch.** Finishing one thing cleanly is better than partially advancing several.

---

## Gameplay

- Some kind of meta gameplay inspired by Dragon Sweeper / Minesweeper. Seeing the world from above the water — top-down view, maybe moving a boat or clicking cells to explore. The two player resources (gear count and chain length, see Level Generation) would be visible here and map naturally to the "depth" concept. Needs further refinement. **Do not add gameplay yet — create a separate brainstorm document for this idea first.**

## Level Generation

- **Add chain length as a second player resource alongside gear count.** Both are constraints the player must stay within to reach the goal.
  - **Gear count** (existing): max number of bends/direction changes. Runs out → can't turn.
  - **Chain length** (new): max total cells the chain spans from start to player position. Runs out → player stops at that cell, even if nothing else blocked them. Measured in whole cells along the path (not visual/bezier length). Backtracks reduce the used length, since the chain literally retracts.
  - During level generation, compute a "chain length to reach" value for each cell (analogous to how gear `depths` are computed today). The level's required chain length is the maximum of those values along the solution path.
  - Both gear count and chain length become **upgradeable player resources** for the meta-game: the boat starts with limited gear count and chain length, and the player unlocks higher values over time, gating access to more complex levels.

- **UI for the two resources** (see Visuals & Polish):
  - Gear count: hearts-style icons in a top bar (player can intuit "I have 3 gears left").
  - Chain length: a Zelda-style potion/meter bar in the top bar — no number shown, just a visual fill level. Players can't calculate total distance in their head, so a bar is more honest than a number.

## Visuals & Polish

- the chain, when it retracts is too slow right now.., I'm talking about when the player is standing still and the chain itself only is moving.

- we should explore making the background have some graphics (as if you're seeing into the water seeing rocks, sandy bottom, sea life) and it being blurry. I'd love to see how that works for our game (to use the webpage blur filter functionality)

## Performance

- can we optimise the algorithm further? also.., would it make sense to move some part of the code over to rust or similar? will it make it less easy for some noob to use ai to copy my game if we do that?

## Mobile / UX

- 

## Bugs / Edge Cases

- when gears show 0 we shouldn't be able to move into a gear we previously placed unless it's the one we came from
