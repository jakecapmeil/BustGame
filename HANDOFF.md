# HANDOFF — read this first

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
| `src/ai.js` | 4 difficulties (easy/medium/hard/brutal), alpha-beta with a wall-clock budget, positional eval built around loaded-tile threat and the edge tax. | **Verified strong**: hard beats medium 11–1 from the *second* seat; brutal beats hard 6–0; worst-case move 28 ms |
| `src/render.js` | Canvas renderer, die-face pip discs, cascade animation. | **Has bug #1** |
| `src/main.js` | Screens, input, serial move queue, AI scheduling, online glue. | Written, barely exercised |
| `src/net.js` | PeerJS host/join, room codes, move relay. | **Never tested** |
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
