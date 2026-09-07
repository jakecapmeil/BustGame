# HANDOFF — read this first

> ## Status — 2026-09-03 pass
>
> **Done:**
> - **Bug #1 (cascade freeze) fixed.** `BoardAnimator` rewritten around a single rAF
>   loop with a `mode` flag — no more `this.anim`/`this.raf` handle collision. `play()`
>   now always settles: on the last frame, on `cancel()`, or via a `setInterval`
>   watchdog that carries playback to completion when rAF is starved (hidden tab /
>   heavy jank). Regression cover in `test/render.test.mjs` (7 tests). Verified in
>   a real solo game: openings bust, cascades resolve, the turn advances every time.
> - **Five bot rungs** (`easy/medium/hard/expert/brutal`). The original four are
>   byte-identical; `expert` is new, a ply deeper than hard on a shorter clock than
>   brutal. Ladder re-measured (24 games/pair): each rung strictly beats the one below.
> - **Mixed local line-up.** "Pass & Play" is now "Local Game": 2–4 seats, each Human
>   or Bot-at-a-difficulty, freely mixed (Boomerang-Fu style). All-human is the old
>   pass-and-play; all-bot is a spectator match.
> - **3–4-player board layout fixed.** Side seat chips were stealing the board's width
>   and squeezing it to a sliver; they now ride the screen edges and the board keeps
>   a 40px lane each side.
> - **Accessibility pass.** Canvas is focusable; arrow keys / WASD move a cursor,
>   Enter/Space plays it; an `aria-live` region announces turns, tile counts and the
>   result.
> - **Service worker** switched to stale-while-revalidate (was cache-first, which
>   pinned stale JS/CSS across deploys). `CACHE` bumped to `bust-v2`.
> - **README.md** written.
>
> **Added after the first pass (trophy ladder):**
> - **Ranked mode** — a Clash-Royale-style trophy ladder vs matchmade bots.
>   `src/rank.js` (pure, 12 tests in `test/rank.test.mjs`): 10 ranks Firecracker→Tsar Bomba,
>   Elo scoring folded over every opponent, a margin multiplier so a blowout win pays
>   more and getting wiped early costs more, soft rank floors, promotion/demotion
>   detection, `localStorage` profile. New `#screen-ranked` (badge, trophy bar,
>   match preview, full ladder), a home-screen rank strip, and a trophy tally on the
>   game-over card. Verified in-browser: a full ranked match scores, persists, and
>   renders the tally; promotion maths checked against `recordMatch`.
> - This is a **solo ladder** — trophies are local and unverified. A real online
>   ranked mode needs a backend (accounts, matchmaking pool, server-authoritative
>   results). `rank.js` takes opponent ratings as input, so an online result could
>   feed the same scorer later.
>
> **Added in the modes + design pass:**
> - **Seven game modes** (`src/modes.js`): Duel 1v1, Rumble 4-way, Big Arena,
>   Mayhem (8 players, 12×12), Duos (2v2 teams), Chaos (mirrored walls), Custom.
>   Mode is chosen first and is orthogonal to solo/local/online; it repaints the
>   app via `<html data-theme>`.
> - **Engine gained teams and walls** — both additive and fully back-compatible
>   (all 17 original tests untouched and passing). `createGame({ teams, blocked })`.
>   A bust reinforces a team-mate instead of stealing; balls fired into a wall are
>   lost like balls fired off the edge. 10 new engine tests.
> - **Eight seat colours.** Indices 0–3 are the original palette and must not move.
>   Past four players the score chips drop the rotated edge layout for flat rails —
>   which also hands the board back ~25% of its width outside pass-and-play.
> - **Design language** stated at the top of `styles.css` and mirrored in the
>   README: a token layer (`--lift-*`, `--r-*`, `--s-*`, motion easings) plus seven
>   theme palette blocks. The canvas reads its skin back out of the same custom
>   properties (`setBoardSkin`), so board and DOM can't drift.
> - **Animation**: balls now visibly *land* — flight occupies the first 72% of a
>   wave, then the post-wave board snaps in with a shock ring per tile; flyers have
>   motion trails and the bursting tile collapses outward.
>
> **Added in the pacing + icon pass:**
> - **Pacing.** Bots pause ~0.9 s before playing (was 0.4 s) and the cascade runs at
>   roughly half speed: a wave opens at 440 ms and ramps down to a 190 ms floor, so a
>   typical 6-wave chain takes 2.3 s instead of 1.2 s. Placements and settles slowed
>   to match. All of it is in `_durationFor` and the `AI_THINK*` constants — one place
>   each.
> - **Balls are bigger**: disc radius went 0.34 → 0.40 of a tile (`DISC_R` in
>   `render.js`), with the pips and the loaded-tile ring rescaled to suit.
> - **`src/icons.js` — every mark in the app, hand-drawn.** No emoji anywhere. The
>   ten ranks are now a yield ladder of real ordnance (firecracker → dynamite →
>   grenade → shell → bombshell → airstrike → MOAB → Fat Man → hydrogen → Tsar
>   Bomba), each badge visibly bigger than the last, the top three carrying an atom
>   mark that gains an orbit per rank. The trophy is a custom cup with a blast spark
>   struck into the bowl. Mode glyphs were unicode characters that sat off-centre in
>   their tiles; they are now diagrams of the match each mode starts, composed
>   symmetrically about the grid centre and sized as a percentage of their container,
>   so nothing needs per-icon nudging. 6 tests in `test/icons.test.mjs` lock the rank
>   and mode maps together and assert no icon smuggles in a text glyph.
>
> **Added in the elimination + bust-feel pass:**
> - **The overlay buttons were never bound.** `#btn-pause`, Resume, Restart, Quit,
>   Play again and Menu had no listeners at all — `restartGame()` and
>   `quitToMenu()` were dead code, so the result card trapped you and only a
>   reload got you out. All six are wired now.
> - **"You lose" card.** Losing your last tile while the board is still live now
>   raises `#overlay-out` with **Spectate** or **Exit to menu**. `offerSpectate()`
>   returns true to `pump()`, which then declines to schedule the next bot — not
>   scheduling is what holds the game behind the card, so there is no separate
>   paused flag to get out of step. `mySeats()` covers pass-and-play too: the card
>   waits until *every* seat this device plays is out.
> - **The bust has a wind-up.** `pipOffsets` gained a fourth face — a 2x2 square —
>   so the over-capacity instant is finally visible: three pips in a triangle, the
>   fourth snaps them into a square, then it goes. A placement that is about to
>   bust is held 520ms instead of 300ms, and during that beat the disc swells and
>   shakes while a ring winds inward onto it.
> - **The opening board is clean.** Placement used to grey out every illegal tile,
>   which shaded two thirds of an untouched board and read as damage. Nothing is
>   shaded now; the legal tiles already pulse, and reaching into a seated player's
>   3x3 zone flashes *their* zone red with your attempted zone outlined over it.
>   New pure helpers `openingMask` / `blockingStarts` in the engine, and the
>   animator owns the flash clock so `drawBoard` stays a pure function of its view.
>   `blockedPlacementTiles` is gone.
>
> **Added in the neural-opponent pass (2026-09-03):**
> - **A sixth bot rung, `neural`.** A 464k-parameter policy+value residual network
>   trained from scratch by AlphaZero-style self-play against nothing but the
>   rules, searching with Gumbel MCTS instead of alpha-beta. Trainer lives outside
>   this repo in `../bustai` (its README is the full account); what ships here is
>   `src/nn.js` (dependency-free forward pass and board encoding), `src/nn-bot.js`
>   (the same Gumbel search as the trainer, in JS) and `assets/net/` (float16
>   weights, ~900 KB, with BatchNorm folded into the convolutions at export).
>   **In Duel it beats Brutal 40-0**, browser code against browser code with the
>   real clocks on both sides, twenty games opening and twenty replying. Its raw
>   policy with no search still beats `hard` 73%. Note that `expert` and `brutal`
>   are the same search differing only in `budgetMs`, and at 7x7 it finishes in
>   ~3 ms, so neither rung ever reaches its clock. Full numbers in
>   [`EVALUATION.md`](EVALUATION.md).
> - **The weights are lazy.** Deliberately *not* in the service worker's install
>   list — only a player who picks the rung fetches them, on selection rather than
>   on the first turn, and the fetch handler caches them afterwards. A failed fetch
>   falls back to Brutal instead of freezing the seat.
> - **`scheduleAI` now awaits.** `chooseMoveAsync` is a promise for every rung
>   (immediate for the five alpha-beta ones). The callback re-checks `epoch` *and*
>   `session.state` identity before enqueueing, because a restart can land while
>   the network is thinking.
> - **A free-for-all takes a different path, on purpose.** The network generalises
>   to four seats; its *search* does not, because the backprop assumes a point for
>   me is a point against you. In a Rumble seat against three `hard` bots, 112
>   games each: 64% wins with no search, 49% at 8 simulations, 19% at 32, 16% at
>   96 — against 26% for the `hard` bot in the same seat and 25% by chance. So
>   three or more seats play the raw prior plus a check for a move that wins on
>   the spot (one evaluation, ~30 ms); two seats get the full search. If you ever
>   want a *searching* free-for-all bot, the value head needs one output per seat
>   and its own training run.
> - **No teams, no walls.** In Duos a team-mate's tiles land in the opponent
>   planes, so the network reads the wrong board. Walls it never saw in training:
>   at a walled four-seat table it wins 21% where `hard` wins 28%. The rung greys
>   out in Duos and Chaos and in a Custom table with either; a local-roster seat
>   left on it is coerced to Brutal.
> - **Two findings about the game itself, in [`EVALUATION.md`](EVALUATION.md).** Duel's
>   7x7 board gives the opening seat an 87% win rate between strong players, and
>   the cause is isolated: take away the opener's *choice* of zone and it drops
>   to 40% (the advantage changes hands), while 9x9 and 11x11 sit at 56-59%
>   whatever you do to the openings. One central 3x3 zone is worth having and the
>   non-overlap rule hands it to whoever asks first. Separately, the engine's
>   `Uint8Array` ball counts can wrap during an enormous cascade and leave a tile
>   owned with zero balls (repro in `../bustai/tests/wraparound_case.json`).
> - **5 new tests** in `test/nn.test.mjs`: the encoder must produce planes identical
>   to the trainer's, the forward pass must match PyTorch at the precision that
>   ships, the net must run on a board size it never trained on, and the JS search
>   must reproduce the Python search *move for move* with the noise off. That last
>   one caught a real divergence (the JS root was not counting its own evaluation
>   as a visit). Tests skip themselves if `assets/net/` is absent. 72/72 pass.
> - **One engine finding, not fixed.** `count` is a `Uint8Array` and an escalating
>   cascade can push a tile past 255; when it wraps to exactly 0 the tile is left
>   **owned with no balls on it** — drawn as owned but empty, still counted for
>   elimination, still clickable. Reachable only through enormous chains; a real
>   6x6 four-player repro is in `../bustai/tests/wraparound_case.json`. Widening
>   `count` to `Uint16Array` would close it. Left alone here because the Python
>   port's job was to agree with this engine, not to change it — but it is a real
>   bug and it is yours to decide on.
>
> **Still needs a live test (could not be done here):**
> - **Online multiplayer** — still never had two clients connected. One real bug fixed
>   on inspection: the client forced `serialization: 'json'` while the host used the
>   PeerJS default, which would garble every packet; the override is removed. Test
>   host/join/lobby/replicate/disconnect with two devices.
>
> **Now verified (2026-09-03):**
> - **PWA offline.** Loaded the app at 375x812, picked the Neural rung so the
>   weights were fetched, then *stopped the server* and reloaded. The app booted
>   entirely from `bust-v9`, `fetch` to the origin failed as expected, and the
>   neural bot still loaded its weights from cache and played a legal move. The
>   cache after one visit holds every listed asset plus `assets/net/*`, which is
>   the lazy path working as intended.


> **To any AI agent picking up this repo: your job is to fix everything listed under
> [Open bugs](#open-bugs) and finish everything under [Remaining work](#remaining-work).**
>
> Work top-to-bottom. The blocking animation bug is first because nothing else can be
> play-tested until it is fixed. Do not refactor the engine to "clean it up" — it is
> tested and correct. Do not weaken or delete tests to make something pass.
>
> Ground rules for this repo:
> - `src/engine.js` is **pure** — no DOM, no randomness, no timers. Keep it that way.
>   The AI search and the online sync both depend on `applyMove` being deterministic.
> - Run `node --test test/engine.test.mjs` before and after every change. 17/17 must pass.
> - Any rules change must come with a test. Any bug you fix must come with a regression test.
> - Mobile is the primary target. Test at 375×812 before calling anything done.

---

## What this is

**BUST** — a tactical board game of chain reactions, built as a mobile-first PWA
(vanilla ES modules, canvas board, no build step, deployable to GitHub Pages as-is).

Based on the mechanics of *Color Wars* by Four Player Games. That specific title is not
indexed well enough to cite, so the rules below come from the project owner's spec and a
reference screenshot, cross-checked against the broader
[Chain Reaction](https://brilliant.org/wiki/chain-reaction-game/) family.

### Rules as implemented

- Each tile holds **0–3 balls**. Owning a tile means having balls on it.
- Tapping a tile you own adds one ball.
- Adding a **4th** ball **busts** the tile: it empties completely and fires **one ball to
  each of its 4 orthogonal neighbours**. Every tile a ball lands on becomes yours.
- If a landing ball pushes a tile past 3, that tile busts too — cascades chain.
- **Opening round:** each player picks one tile on the empty board, which busts
  immediately. Openings claim a **3×3 mask** and no two masks may overlap.
- Win by eliminating every other colour.

### Two rules findings the owner should know

1. **This is not Chain Reaction.** Two deliberate differences: capacity is a uniform 3
   (Chain Reaction uses neighbour-count critical mass — 2 corner / 3 edge / 4 interior),
   and a bust always fires 4 balls even with nowhere to put them. So **edge busts lose 1
   ball off the board and corner busts lose 2**. This makes edges cheap to hold and
   expensive to attack from, which is the main strategic texture of the game. The AI
   evaluation in `src/ai.js` leans on it.

2. **Added guard not in the original spec:** an opening is illegal if it would leave a
   later player with no legal 3×3 slot (`placementFeasible` in `src/engine.js`). Without
   it, on 5×5 player 1 takes the centre and player 2 has nowhere legal to go. Consequence:
   **on a 5×5 board the centre is not a legal opening.** This is intentional and tested.
   If the owner wants different behaviour, that's a product decision, not a bug.

---

## Open bugs

### 1. BLOCKING — cascade animation freezes mid-wave

**Symptom.** Start a solo game, tap an opening tile. The tile busts and the four balls
render *in flight*, then stop permanently. The turn never advances, the score chips stay
at 0, and the banner stays on "Pick your opening tile".

**What is known:**
- The engine is fine. `applyMove` returns `ok: true` with correct frames — verified by
  importing `src/engine.js` directly in the page console.
- Hit-testing is fine. `hitTest` correctly returns tile index 7 for a tap at (1,1).
- Legality is fine. `legalPlacements` returns 36 tiles and includes 7.
- **No exception is thrown.** A page-level `error` and `unhandledrejection` listener
  caught nothing across a full reproduction.
- `requestAnimationFrame` is alive in the page (verified separately).
- Therefore: `BoardAnimator.play()` in `src/render.js` never resolves its promise, so the
  `await animateMove(...)` inside `pump()` in `src/main.js` blocks forever and the move
  queue stalls.

**Where to look.** The `step()` closure in `BoardAnimator.play` (`src/render.js`). The rAF
chain is stopping silently mid-wave. Prime suspects, roughly in order:
- `this.anim` and `this.raf` both hold rAF handles from the same counter, and
  `startIdle`/`stopIdle`/`play`/`cancel` all read and write them. A stale
  `cancelAnimationFrame` very plausibly kills the live animation handle. Consider giving
  the idle loop and the animation loop separate, unambiguous ownership, or a single
  loop with a mode flag.
- `setView()` is called during playback from other code paths and only guards on
  `if (!this.anim)`.
- Confirm `durationFor` never returns `0`/`NaN` (that would make `t` non-finite and the
  `t >= 1` advance behave oddly).

**Repro** (browser pane must be *visible* — rAF is paused while hidden, which will look
like the same bug but is not):
```
python3 -m http.server 8899 --bind 127.0.0.1   # from repo root
# open http://127.0.0.1:8899/ at 375x812, tap Solo -> Start -> tap any tile
```

**Definition of done:** a full solo game can be played to a winner, cascades of 5+ waves
animate smoothly to completion, and the turn advances every time.

---

## Remaining work

Ordered. Each item assumes the one before it is done.

1. **Fix bug #1 above.**

2. **Play-test the local modes end to end.** None of this has been verified past the first
   move: solo 2P and 4P at all four difficulties, pass & play at 2/3/4 players, all three
   board sizes, elimination mid-game, game-over overlay, restart, quit-to-menu.
   Watch specifically for: turn order skipping eliminated players, seat chips rotating to
   the right screen edges, and the board resizing correctly on orientation change.

3. **Online multiplayer is completely untested.** `src/net.js` (PeerJS over WebRTC) is
   written but **has never had two clients connected to each other**. Treat all of it as
   unverified. Test with two browser tabs/devices: host a room, join by code, verify the
   lobby fills, start, and confirm moves replicate in both directions.
   Design intent to preserve: because the engine is deterministic, **only move indices
   cross the wire**. The host validates and echoes; clients apply only on echo. Do not
   replace this with full state sync.
   Also verify: rejecting a join when the room is full, a player disconnecting mid-game,
   and the host leaving.

4. **Write `README.md`** — rules, screenshots, how to run locally, and GitHub Pages deploy
   notes (the app is static; Pages should serve it from the repo root with no build).

5. **PWA verification.** Service-worker registration currently errors in some sandboxed
   browsers; it is caught and non-fatal, but confirm offline play actually works once
   installed, and that solo/pass-and-play need no network at all.

6. **Accessibility pass.** The board is a bare canvas with no keyboard path and no screen
   reader affordance. At minimum consider arrow-key navigation and an aria-live turn
   announcement.

---

## Map of the code

| File | What it does | State |
|---|---|---|
| `src/engine.js` | Pure rules. Board, placement legality, `applyMove`, cascade resolution, win detection. Returns an animation frame script. | **Tested, 17/17 pass** |
| `test/engine.test.mjs` | Rules tests incl. a 40-trial self-play fuzz asserting no tile ever exceeds capacity. | Passing |
| `src/ai.js` | 6 rungs. Five are alpha-beta on a wall-clock budget with a positional eval built around loaded-tile threat and the edge tax; `neural` delegates to `nn-bot.js` and falls back to Brutal when the weights are missing or the table is wider than two seats. | **Verified strong**: hard beats medium 11–1 from the *second* seat; brutal beats hard 6–0; worst-case move 28 ms |
| `src/render.js` | Canvas renderer, die-face pip discs, cascade animation. | **Has bug #1** |
| `src/main.js` | Screens, input, serial move queue, AI scheduling, online glue. | Written, barely exercised |
| `src/net.js` | PeerJS host/join, room codes, move relay. | **Never tested** |
| `src/nn.js` | Neural rung's forward pass and board encoding. Dependency-free; BatchNorm was folded in at export so there are no normalisation layers here. | **Tested against PyTorch** |
| `src/nn-bot.js` | Gumbel MCTS over `engine.js` guided by `nn.js`; plans its search around measured device speed. | **Tested**: reproduces the trainer's search move for move |
| `assets/net/` | float16 weights (~900 KB) plus manifest. Fetched on demand, not precached. | Exported from `../bustai` |
| `test/nn.test.mjs` | Encoder parity, forward-pass parity, unseen board size, search parity, adaptive budget. Skips itself if `assets/net/` is missing. | 6 tests, passing |
| `src/audio.js` | Synthesised WebAudio SFX, zero audio assets. | Written, unverified |
| `index.html` / `styles.css` | Mobile-first shell, seat chips rotated to each player's screen edge. | Home screen verified at 375×812 |
| `sw.js` / `manifest.webmanifest` / `assets/` | PWA offline cache, installable manifest, generated icons. | Written, unverified |

## Verification log

What has actually been confirmed, so nobody re-litigates it:

- `node --test test/engine.test.mjs` → **17/17 pass**, including the capacity-invariant fuzz.
- AI ladder measured over ~80 games; strictly ordered, all games terminate, no illegal
  moves generated, max move time 28 ms.
- Home screen renders correctly at 375×812.
- Board renders, an opening move applies, and the bust animation *starts*.
- Everything else in this repo is unverified.
