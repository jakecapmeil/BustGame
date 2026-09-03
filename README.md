# BUST

A fast tactical board game of chain reactions. Load a tile past three balls and it
**busts** — flinging one ball to every orthogonal neighbour and stealing whatever
they land on. Wipe every other colour off the board to win.

Mobile-first PWA. Vanilla ES modules, a canvas board, **no build step**. Deploys to
GitHub Pages from the repo root as-is.

---

## Rules

- Every tile holds **0–3 balls**. Owning a tile means having balls on it.
- Tap a tile you own to add a ball.
- Adding a **4th** ball **busts** the tile: it empties and fires **one ball to each
  of its four orthogonal neighbours**. Every tile a ball lands on becomes yours.
- If a landing ball pushes a neighbour past 3, that tile busts too — cascades chain.
- A bust always fires four balls, **even with nowhere to put them**. Bust on an edge
  and one ball falls off the board; bust in a corner and two do. Edges are cheap to
  hold and expensive to attack from — this is the game's main strategic texture.
- **Opening round:** each player picks one tile on the empty board, which busts on
  the spot. An opening claims a **3×3 zone** and no two zones may overlap — the
  board is not shaded to show this; reach into someone's zone and it flashes red.
  An opening that would leave a later player with nowhere legal to go is also
  barred — so on a 5×5 board the exact centre is not a legal opening.
- A player is eliminated when they have no tiles left (only once the opening round is
  over). Last colour standing wins. Losing your last tile with the board still live
  raises a **you lose** card offering to spectate the rest or quit.

This is *not* Chain Reaction: capacity is a uniform 3 (not neighbour-count critical
mass), and busts always throw four balls.

## How it's organised

Two independent choices: **what** you play (the mode) and **who** you play it with.

### Modes — the shape of a match

Pick one on the mode screen; it applies everywhere and repaints the whole app in
that mode's palette.

| Mode | Shape | Board |
|---|---|---|
| **Duel** | 1 v 1 | 7×7 |
| **Rumble** | 4-player free-for-all | 8×8 |
| **Big Arena** | 4 players, room to move | 10×10 |
| **Mayhem** | 8 players | 12×12 |
| **Duos** | 2 v 2 teams | 10×10 |
| **Chaos** | 4 players + a mirrored maze of walls | 10×10 |
| **Custom** | 2–8 seats, board size, teams and wall density all yours | up to 13×13 |

Two modes change the rules, not just the numbers:

- **Duos.** Partners alternate seats so turn order alternates sides. A bust
  **reinforces** a team-mate's tile instead of stealing it, and your side is only
  out when *both* of you are wiped. Territory is tinted by team; discs stay per
  player, so you read sides at a glance and still know who owns what.
- **Chaos.** Walls are mirrored across both axes so no seat gets a better corner.
  A ball fired into a wall is **gone** — walls tax a bust exactly the way the
  board edge does, which is the whole tactical point.

### Then: solo, local or online

- **Ranked** — the current mode, against matchmade bots, for trophies (below).
- **Solo** — the current mode against bots at one difficulty. No trophies.
- **Local** — one device, passed around. Fill every seat with **any mix of people
  and bots**. All humans is classic pass-and-play; all bots is a spectator match.
- **Online** — across devices over WebRTC (PeerJS). One player hosts and shares a
  5-character room code; the mode, board, teams and wall map all ride along in the
  start packet so every client builds a byte-identical board. Because the engine is
  deterministic, only move indices cross the wire after that.

## Ranked ladder

A trophy count that goes up when you win and down when you lose, against bots that
get matchmade to your level.

- **Elo core.** Each match is scored as Elo against every opponent (for a free-for-all,
  as an implicit 1-v-1 versus each other player by finishing order). Beating someone
  rated above you pays more; losing to someone below costs more. K-factor is larger
  for your first ten placement matches and tightens at the top ranks.
- **Margin matters.** A crushing win (you hold most of the board, game ended fast)
  pays a bonus; getting wiped out early loses more than scraping a narrow defeat.
- **Ranks.** Ten tiers, each at a higher trophy threshold, run as a *yield ladder*
  of real explosives — Firecracker, Dynamite, Grenade, Shell, Bombshell, Airstrike,
  MOAB, Fat Man, Hydrogen, Tsar Bomba — and every badge is that rank's own bomb,
  visibly larger than the one below it. The last three go nuclear and pick up an
  extra orbit on their atom mark apiece. Your rank sets how *hard* the bots play;
  the selected **mode** sets the shape of the match. So you climb one ladder
  whichever mode you prefer. Cross a threshold and you're promoted.
- **Teams count as one result.** In Duos a partner's win is your win, team-mates
  never appear in your Elo maths, and both partners share first place.
- **Soft floor.** A loss can dip you one band below your rank's threshold but can't
  drop you a whole rank in one match.
- Progress is stored locally (`localStorage`). It is a **single-player ladder** — a
  true server-authoritative online ranked mode would need a backend (accounts,
  matchmaking pool, result verification); the trophy engine (`src/rank.js`) is written
  so an online result could feed it later.

## Bot difficulty

Five rungs, each strictly stronger than the last:

| Rung   | Search        | Notes |
|--------|---------------|-------|
| Easy   | greedy + noise | blunders often, plays fast |
| Medium | 1-ply         | solid, occasional slip |
| Hard   | 2-ply alpha-beta | punishes loose play |
| Expert | 3-ply         | no noise, no blunders |
| Brutal | 3-ply, long clock | widest search, plays to win |

The search runs on a wall-clock budget so it never janks a phone mid-turn.

## Accessibility

- The board canvas is focusable. **Arrow keys** (or WASD) move a cursor, **Enter** or
  **Space** plays the highlighted tile.
- An `aria-live` region announces whose turn it is, the tile counts, and the result.
- Honours `prefers-reduced-motion`.

## Run it locally

Any static file server works — there is no build. From the repo root:

```bash
python3 -m http.server 8000
```

then open <http://127.0.0.1:8000/>. (Node: `npx serve .`, or the VS Code Live Server
extension.) Service workers and WebRTC need `http://localhost` / `127.0.0.1` or HTTPS;
opening `index.html` from the filesystem will not work.

## Tests

Pure engine and animator logic run under Node's test runner, no dependencies:

```bash
node --test test/*.mjs
```

- `engine.test.mjs` — rules, placement legality, cascades, elimination, plus a
  self-play fuzz asserting no tile ever exceeds capacity.
- `render.test.mjs` — `BoardAnimator` playback: every `play()` settles (final frame,
  `cancel()`, or the hidden-tab watchdog), and the idle and animation loops never
  fight over a frame handle.
- `rank.test.mjs` — trophy maths: Elo direction, the margin / "how badly you lost"
  multipliers, free-for-all placement, rank floors, and promotion detection.

## Deploy to GitHub Pages

The app is fully static and expects to be served from the site root.

1. Push to `main`.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. The service worker (`sw.js`) and manifest use relative paths, so a project-pages
   URL (`user.github.io/BustGame/`) works without changes.

On each deploy the service worker serves the cached copy immediately and refreshes it
in the background (stale-while-revalidate), so an update lands on the next load. Bump
`CACHE` in `sw.js` if you need it to take effect at once.

## Project layout

| File | Role |
|---|---|
| `src/engine.js` | Pure rules. Deterministic — no DOM, no randomness, no timers. |
| `src/ai.js` | The five bots: positional eval + alpha-beta on a time budget. |
| `src/rank.js` | Trophy ladder: ranks, Elo + margin scoring, matchmaking, profile storage. |
| `src/modes.js` | Mode table, seeded mirrored wall generation, per-mode setup. |
| `src/render.js` | Canvas renderer and the cascade animator. |
| `src/icons.js` | Every mark in the app, hand-drawn on one 24×24 grid. No emoji. |
| `src/main.js` | Screens, input, the serial move queue, AI scheduling, online glue. |
| `src/net.js` | PeerJS host/join, room codes, move relay. |
| `src/audio.js` | Synthesised WebAudio SFX — zero audio assets. |
| `index.html` / `styles.css` | Mobile-first shell. |
| `sw.js` / `manifest.webmanifest` / `assets/` | PWA offline cache, installable manifest, icons. |

## Design language

`styles.css` opens with the full statement of it; the short version is six rules:

1. **Extruded, not flat.** Controls sit on a hard, unblurred bottom shadow and
   collapse into it on press. Blur is reserved for things genuinely floating —
   modals, and the board's tiles.
2. **One accent per screen.** The active mode owns the palette. The only other
   saturated colours in the chrome are the eight seat colours, and those belong to
   the board.
3. **Big, round, confident.** Radii step 12 / 18 / 26 / pill. Nunito 700–900 only.
4. **Invert to focus.** The app is a coloured field carrying near-white text;
   anything that demands attention becomes a cream card with dark text.
5. **Numbers are the hero.** Scores, trophies and deltas get the largest type on
   screen, always tabular so they don't jitter while counting.
6. **Motion is physical.** Things overshoot slightly and settle. Nothing is linear.
   `prefers-reduced-motion` removes all of it. A bust is the clearest case: the
   fourth ball squares the pips up, the tile swells and shakes while a ring winds
   in on it, and only then does it go.
7. **Every mark is drawn here.** No emoji, anywhere — they size and centre
   differently on every platform and ignore `color`. `src/icons.js` holds all of
   them on one 24×24 grid, two tones (`currentColor` plus one black wash), sized
   by their container rather than a font size. That is why a 92px rank hero and a
   28px ladder badge are optically identical.

Themes swap only a palette block via `<html data-theme>`; nothing else in the sheet
knows which mode is active. The canvas reads the same custom properties back out
through `setBoardSkin`, so board and DOM can never drift apart.
