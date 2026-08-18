# Gem Quest

A match-3 puzzle game for mobile — 150 progressively harder levels, consumable
boosters, and a permanent upgrade tree. Built as a self-contained HTML5 + Canvas
PWA: it runs in any mobile browser, installs to the home screen, and wraps into a
native iOS/Android app with Capacitor without changing any game code.

```bash
npm install
npm run dev      # dev server with live rebuild → http://127.0.0.1:5178
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | esbuild watch + dev server |
| `npm run build` | production bundle into `dist/` |
| `npm run serve` | serve an existing `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run sim` | headless balance harness (see below) |
| `npm run debug` | trace a single level: `LEVEL=130 npm run debug` |

## Playing

Swipe a gem into a neighbour, or tap one then tap a neighbour. Match three or
more of a colour. Every colour also has its own silhouette, so the board stays
readable without relying on hue.

**Specials.** Four in a row makes a rocket that clears its line; an L or T makes
a bomb that blasts 3x3; five in a row makes a colour bomb. Swapping two specials
combines them — two rockets clear a full row *and* column, rocket + bomb clears
three of each, two bombs make a 5x5 blast, colour bomb + special upgrades every
gem of that colour and fires them all, and two colour bombs clear the board.

**Goals.** Five objective types unlock across the run: reach a score (level 1),
collect a colour (7), clear jelly (11), break blockers (22), and drop star fruit
off the bottom of the board (33). From level 61 levels start pairing two goals.

**Obstacles.** Crates take one or two hits from a neighbouring match. Stones only
break to a special's blast. Chains lock a gem until a match frees it. Later
boards are cut into shapes — diamonds, hourglasses, wells, pillars.

## Progression and economy

Coins come from clearing levels, scaled by stars, leftover moves and a first-clear
bonus. Lives cap at five and refill one every twenty minutes.

**Boosters** are spent before a level: +5 Moves, Twin Rockets, Prism Gem.
**Power-ups** are used during one: Hammer, Shuffle, Free Swap — none cost a move.
**Upgrades** are permanent and apply to every level afterwards: Deep Pockets
(+1 move per rank), Momentum (cascade scoring), Lucky Drops (rocket chance on a
plain match), Gold Rush (coin rate), Vitality (life cap and refill speed).

Progress lives in `localStorage` under `gem-quest/profile/v1`.

## How the 150 levels are built

`src/game/levels.ts` generates every level deterministically from its id, so the
same level always produces the same board. A difficulty curve rises across the
run but breathes within each ten-level episode: the first level of an episode is
a breather, the tenth is a boss. Board size, colour count, shape, obstacle
density and goal targets all derive from that curve.

Move budgets are fixed *first*, and every target is then sized against the budget.
That ordering is what keeps late levels hard rather than impossible. All fifteen
boss levels are additionally hand-tuned in the `MILESTONES` table.

## Balancing is measured, not assumed

`npm run sim` plays every level with a heuristic bot and reports win rates per
level and per episode:

```
TRIALS=10 SKILL=0.85 npm run sim
```

`SKILL` ranges 0..1 (1 always plays the best move it evaluates). The curve at
skill 0.85 currently runs from 100% in episode 1 down to roughly 35% at the end,
with bosses dipping below their neighbours. A real player does better than the
bot, since boosters and upgrades are not simulated.

This harness caught the substantive bugs during development — most importantly
that the bottom rows of a board freeze permanently. Clears only disturb the cells
*above* them, so a region with no legal move can never gain one on its own, which
made ingredient and low-jelly goals unreachable. The engine now reshuffles
whenever fewer than `minMoves` legal swaps remain (`ResolveContext.minMoves`).

## Layout

```
src/engine/    board.ts (matching, cascades, gravity, specials), types.ts, rng.ts
src/game/      levels.ts (the 150), session.ts (goals/moves), upgrades.ts, save.ts
src/render/    renderer.ts — canvas drawing + step-timeline playback
src/ui/        app.ts — screens, input, modals
src/tools/     sim.ts (balance harness), debug.ts (single-level trace)
```

The engine is pure logic and returns an animation timeline (`Step[]`) that the
renderer replays; it has no DOM dependency, which is what lets the simulator play
thousands of levels headlessly.

## Shipping as a native app

The build output is a static, self-contained PWA. To wrap it:

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "Gem Quest" ai.thebrief.gemquest --web-dir=dist
npx cap add ios && npx cap add android
npm run build && npx cap sync
```

Xcode is required for the iOS target and is not currently installed on this
machine.
