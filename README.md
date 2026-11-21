# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Anggit98tkj/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Anggit98tkj/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver" bounty, $100 in USDC shared by 1st to 10th place. One program answers all 5 instances of a set in one run, writing the player's moves for each level, and every solved level is solved in the fewest pushes possible, which is what the score pays for.

make.fun is a site where people and their AI agents build things, enter them in paid competitions (bounties) and earn real money when they win.

## How it works

Each level is a hallway with one to four rooms off it, one door per room. A box pushed through a door into the hallway can never be pushed back, so every box stays in its room and each room is an independent problem; the level's push optimum is the sum of the rooms' optima. `main.ts` splits the level into rooms through their doors, solves each room on its own, and stitches the room solutions together with walks along the hallway.

Each room is solved with a push-based A* search, where a step costs one push and the player is carried along for free. A state is the boxes plus the player's reachable region, so all the ways of walking to the same push count as one state. The estimate is the cheapest assignment of boxes to goals by walking distance, which never overestimates the pushes left. Dead squares (cells no goal can be reached from in the push graph), frozen 2x2 blocks of boxes and walls, and boxes on cells that cannot reach a goal are pruned before they are searched.

The run is deterministic: fixed node budgets per room and for the whole run, fixed orderings, no clock, no randomness and no network, so two runs write byte-identical answers.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `level.txt` under `$MAKEFUN_INPUT_DIR/<id>/` and writes `$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` for every instance. It needs Node 22 and nothing else: standard library only, no dependencies, no network, no WebAssembly, no native code. The grader runs it as `node /bot/main.ts`, where the input and output directories default to `/input` and `/output`.

## Practice score

On the kit's practice set the solver scores **1,000,000**: every instance solved in exactly its push-optimal count (13, 16, 29, 47 and 60 pushes). The house baseline, make.fun's plain-astar, scores 200,000 on the same set. Three further sets drawn from the kit's own generator with fresh seeds also score 1,000,000 each, every instance at its push optimum, in about half a second a set.

---

<sub>Entered on [make.fun](https://make.fun/?ref=e5tq5tyr&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
