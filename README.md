# Gem Quest

A match-3 puzzle game for mobile — 1000 progressively harder levels across ten
regions, consumable boosters, and a twelve-branch permanent upgrade tree. Built as a self-contained HTML5 + Canvas
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
| `npm run deploy` | build into `docs/` for GitHub Pages |
| `npm run sim` | headless balance harness (see below) |
| `npm run debug` | trace a single level: `LEVEL=130 npm run debug` |

## Playing

Swipe a piece into a neighbour, or tap one then tap a neighbour. Match three or
more of a kind.

The seven pieces are a **Japanese flag**, a **white dog**, a **tennis ball**, an
**onigiri**, a **sewing machine**, a **ball of yarn** and a **paw print**. Three
of those are mostly white, so each sits on its own strongly coloured tile — the
artwork gives identity, the tile keeps them separable at a glance.

**Specials.** Four in a row makes a **scoot** — the white dog drags his rear
along the whole row or column, wiping out everything in his path; an L or T makes
a bomb that blasts 3x3; five in a row makes a colour bomb. Swapping two specials
combines them — two scoots clear a full row *and* column, scoot + bomb clears
three of each, two bombs make a 5x5 blast, colour bomb + special upgrades every
gem of that colour and fires them all, and two colour bombs clear the board.

**Goals.** Five objective types unlock across the run: reach a score (level 1),
collect a colour (5), clear jelly (8), break blockers (16), and drop star fruit
off the bottom of the board (26). From level 45 levels start pairing two goals.

**Obstacles.** Crates take one or two hits from a neighbouring match. Stones only
break to a special's blast. Chains lock a gem until a match frees it. Later
boards are cut into shapes — diamonds, hourglasses, wells, pillars.

**Late-run pressure.** Three things escalate past the midpoint. *Fuse gems*
(level 120+) carry a countdown that ticks once per move — let one hit zero and
the level is lost outright, which is the only failure that is not simply running
out of moves. *Triple jelly* (600+) needs three separate clears on one tile. A
*seventh colour* (700+) appears on the back half of each episode and sharply
cuts how many legal moves exist at any moment.

## Progression and economy

Coins come from clearing levels, scaled by stars, leftover moves and a first-clear
bonus. Lives cap at five and refill one every twenty minutes.

**Boosters** are spent before a level: +5 Moves, Twin Rockets, Prism Gem.
**Power-ups** are used during one: Hammer, Shuffle, Free Swap — none cost a move.
**Upgrades** are permanent and split across three branches, each gated behind a
star total so the tree opens up as you go:

- *Power* — Momentum (cascade scoring), Demolition (blast radius against
  blockers), Alchemy (four-matches becoming bombs), Starlight (free specials on
  every board).
- *Fortune* — Gold Rush (coin rate), Lucky Drops (rocket chance on a plain
  match), Prospector (score from blockers and jelly), Quartermaster (chance a
  power-up is not consumed).
- *Endurance* — Deep Pockets (+1 move per rank), Vitality (life cap and refill
  speed), Defuser (longer fuse clocks), Second Wind (chance to refund a lost
  life).

Progress lives in `localStorage` under `gem-quest/profile/v1`.

## How the 1000 levels are built

`src/game/levels.ts` generates every level deterministically from its id, so the
same level always produces the same board. A difficulty curve rises across the
run but breathes within each ten-level episode: the first level of an episode is
a breather, the tenth is a boss. Board size, colour count, shape, obstacle
density and goal targets all derive from that curve.

Move budgets are fixed *first*, and every target is then sized against the budget.
That ordering is what keeps late levels hard rather than impossible.

The ten bosses of the opening region are hand-tuned in the `MILESTONES` table,
since that stretch is what every player sees. Beyond level 100 the generated
curve stands on its own — at a thousand levels, per-level authoring is not
practical, so later levels are procedural variations on the tuned curve rather
than individually authored puzzles.

## Balancing is measured, not assumed

`npm run sim` plays every level with a heuristic bot and reports win rates per
level and per episode:

```
TRIALS=10 SKILL=0.85 npm run sim
```

`SKILL` ranges 0..1 (1 always plays the best move it evaluates). `SAMPLE` is the
stride — a thousand levels is too many to play exhaustively. **Keep the stride
coprime with 10.** An even stride lands on `id % 10 == 0` every time, samples
nothing but boss levels, and reports a curve that does not exist; that mistake
made region 1 look harder than region 5 during tuning.

The curve at skill 0.85 currently runs from about 77% in region 1 down to
10-15% in the final regions. A real player does better than the bot, since
boosters and upgrades are not simulated.

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

## Dev tools

Tap the ◆ beside the title **seven times** to reveal a 🛠 Dev tab in the shop.
Tapping seven times again hides it. Everything there is local to that browser
profile — nothing is shared, synced, or visible to other players.

- **Infinite coins** — purchases stop deducting, and power-ups are never used up.
- **Infinite lives** — levels never cost a life, and start even at zero.
- One-off actions: add a million coins, stock every item, unlock all 1000
  levels, max every upgrade, refill lives, win the level in progress.

The same tools are on the console, which is easier on desktop:

```js
gemQuest.dev.help()        // list every command
gemQuest.dev.infinite()    // coins, items and lives all stop being spent
gemQuest.dev.coins(50000)  // one-off top-up
gemQuest.dev.unlockAll()
gemQuest.dev.maxUpgrades()
gemQuest.dev.goto(750)     // jump straight to a level
gemQuest.dev.win()         // clear the level in progress
```

## Installing it as an app

Gem Quest is a PWA, so it installs to a phone home screen from the link with no
store involved:

- **iPhone** — open the link in Safari, tap Share, then *Add to Home Screen*.
  iOS fires no install event, so the game shows these steps itself.
- **Android / desktop Chrome** — an install banner appears; one tap and it is on
  the home screen.

Installed, it runs full screen with its own icon and **works with no
connection** — the service worker precaches the whole app (one HTML file, one
bundle, one stylesheet and the icons) and serves cache-first, refreshing in the
background for next launch.

Icons are generated from `public/icon.svg` with `sips`:

```bash
for size in 180 192 512; do sips -s format png -Z $size public/icon.svg --out public/icon-$size.png; done
```

`icon-maskable-512.png` insets the same art into the safe zone so Android's
circle crop cannot clip the dog's ears.

### Sharing

The ↗ button opens a sheet with the link, the system share sheet, and a QR
code. The QR encoder in `src/ui/qr.ts` is written from scratch — byte mode,
error-correction level M, versions 1-10 — because an offline app cannot pull a
library from a CDN at runtime. It is verified by decoding its own output back
with `BarcodeDetector`, not by eyeballing it.

### Onboarding

Short cards introduce each mechanic the first time it can appear — matching,
the dog sweep, jelly, crates, chains, star fruit, fuses — shown before that
level rather than dumped up front. Seen cards are remembered per profile; the
**?** button replays them.

## Publishing

`npm run deploy` builds a minified, self-contained copy into `docs/`, which
GitHub Pages serves as-is. There is no server component and no analytics; all
progress stays in the player's own browser.

To play on a phone over local Wi-Fi instead, `npm run serve` binds to all
interfaces and prints the LAN URL.

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
