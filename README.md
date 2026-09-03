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
  the spot. An opening claims a **3×3 zone** and no two zones may overlap. An opening
  that would leave a later player with nowhere legal to go is also barred — so on a
  5×5 board the exact centre is not a legal opening.
- A player is eliminated when they have no tiles left (only once the opening round is
  over). Last colour standing wins.

This is *not* Chain Reaction: capacity is a uniform 3 (not neighbour-count critical
mass), and busts always throw four balls.

## Modes

- **Ranked** — a Clash-Royale-style trophy ladder (see below).
- **Solo** — you against 1–3 bots at one difficulty. No trophies at stake.
- **Local Game** — one device, passed around. Fill 2–4 seats with **any mix of
  people and bots**; each bot picks its own difficulty. All humans is classic
  pass-and-play; all bots is a spectator match.
- **Online** — play across devices over WebRTC (PeerJS). One player hosts and shares
  a 5-character room code. Because the engine is deterministic, only move indices
  cross the wire; the host referees and every client replays the same stream.

## Ranked ladder

A trophy count that goes up when you win and down when you lose, against bots that
get matchmade to your level.

- **Elo core.** Each match is scored as Elo against every opponent (for a free-for-all,
  as an implicit 1-v-1 versus each other player by finishing order). Beating someone
  rated above you pays more; losing to someone below costs more. K-factor is larger
  for your first ten placement matches and tightens at the top ranks.
- **Margin matters.** A crushing win (you hold most of the board, game ended fast)
  pays a bonus; getting wiped out early loses more than scraping a narrow defeat.
- **Ranks.** Ten tiers from Woodline to Legend, each at a higher trophy threshold.
  Your rank sets the opponents: difficulty pool, how many of them (1-v-1 up to 1-v-3),
  and the board size. Cross a threshold and you're promoted.
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
node --test test/engine.test.mjs test/render.test.mjs
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
| `src/render.js` | Canvas renderer and the cascade animator. |
| `src/main.js` | Screens, input, the serial move queue, AI scheduling, online glue. |
| `src/net.js` | PeerJS host/join, room codes, move relay. |
| `src/audio.js` | Synthesised WebAudio SFX — zero audio assets. |
| `index.html` / `styles.css` | Mobile-first shell. |
| `sw.js` / `manifest.webmanifest` / `assets/` | PWA offline cache, installable manifest, icons. |
