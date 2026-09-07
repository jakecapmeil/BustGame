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
- Walls eat a ball the same way the edge does — unless **bouncy walls** are turned on
  (a Custom option), in which case a ball thrown at a wall rebounds and stays on the
  tile it left, capped at the tile's own capacity of three. The board edge always
  taxes a bust; only walls are negotiable.
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
| **Custom** | 2–8 seats, board size, teams, wall density and wall behaviour all yours | up to 13×13 |

Two modes change the rules, not just the numbers:

- **Duos.** Partners alternate seats so turn order alternates sides. A bust
  **reinforces** a team-mate's tile instead of stealing it, and your side is only
  out when *both* of you are wiped. Territory is tinted by team; discs stay per
  player, so you read sides at a glance and still know who owns what.
- **Chaos.** Walls are mirrored across both axes so no seat gets a better corner.
  A ball fired into a wall is **gone** — walls tax a bust exactly the way the
  board edge does, which is the whole tactical point.

**Custom** can invert that last rule. With **bouncy walls** on, a ball thrown at a
wall comes back and stays on the tile it left, so a walled-in tile is no longer
punished for its neighbours and the maze becomes cover rather than a tax. The
rebound is capped at capacity, which is what keeps it a rule and not a bomb: a
tile can never re-detonate itself off its own rebound.

The bots know about it: the hand-written evaluation prices a tile by how many
of its sides actually *eat* a ball, so with bouncy walls on it stops paying a
safety bonus for hugging a wall and counts only the board's own edge.

### Then: solo, local or online

- **Ranked** — the current mode, against matchmade bots, for trophies (below).
- **Solo** — the current mode against bots at one difficulty. No trophies.
- **Local** — one device, passed around. Fill every seat with **any mix of people
  and bots**. All humans is classic pass-and-play; all bots is a spectator match.
- **Online** — across devices over WebRTC (PeerJS). See below.

## Online is a party, not a match

The unit is a **group of people**, not a single game. You get everyone in once and
then play round after round out of the same room.

- **Host once.** One player hosts and gets a 5-character code and a **shareable
  link** (`?party=CODE`). Opening that link drops you straight into the room, so
  nobody has to read a code off a screenshot.
- **Everyone has a name.** Type it once; it is remembered, it shows on every
  lobby row, and it rides the score chips during the round.
- **Everyone ticks ready.** The host's Start button only appears once the whole
  party has, so a round never begins on somebody still finding their seat.
- **The party sets the table.** The *mode* supplies the map — board size, teams,
  walls — and the *party* supplies the seat count, with the board growing to fit
  however many turned up (`buildPartySetup`). So a room is never capped at
  whatever the mode happens to seat.
- **Play again is a vote.** When a round ends, everyone gets the result card with
  the party on it. Each "Play again" is a tick; when the last one lands the next
  round deals itself. Nobody is re-invited, and the host can **change the map**
  from that same card between rounds.
- **A round can end without the party ending.** If someone drops mid-game the
  round is abandoned — every client is replaying a move stream keyed to seat
  indices, so it has to be — but everyone lands back in the lobby together.

The mode, board, teams, wall map and wall behaviour all ride along in the start
packet so every client builds a byte-identical board. Because the engine is
deterministic, only move indices cross the wire after that, and the host judges
each one against the board it will actually land on rather than against whatever
it was showing when the packet arrived.

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

Six rungs, each stronger than the last:

| Rung   | Search        | Notes |
|--------|---------------|-------|
| Easy   | greedy + noise | blunders often, plays fast |
| Medium | 1-ply         | solid, occasional slip |
| Hard   | 2-ply alpha-beta | punishes loose play |
| Expert | 3-ply         | no noise, no blunders |
| Brutal | 3-ply, long clock | widest search, plays to win |
| Neural | learned net (+ MCTS at 1v1) | trained by self-play; no team play |

The first five run a hand-written positional evaluation on a wall-clock budget,
so they never jank a phone mid-turn.

**Neural** is a different animal. It is a small residual network — 464k
parameters, policy and value — trained from scratch by AlphaZero-style
self-play against nothing but the rules (the trainer lives in `../bustai`), and
it searches with Gumbel MCTS rather than alpha-beta. It brings its own idea of
what a position is worth instead of the hand-written one.

In Duel it is a long way clear of the rest of the ladder. Played bot against
bot in the browser, with both sides on their real clocks, it beats **Brutal
40-0** over 40 games — twenty opening, twenty replying. Its raw policy, with no
search at all, still beats `hard` 73%.

Worth knowing while reading that: `expert` and `brutal` are the same search
here, differing only in `budgetMs`, and at 7x7 that search finishes in about
3 ms — so neither rung ever reaches its clock and the two play identically.
Full numbers in [`EVALUATION.md`](EVALUATION.md).

It also plans its search around the device. A forward pass costs an order of
magnitude more on a budget phone than on a laptop, so the bot measures what one
actually costs, works out how many simulations fit in its 1.4-second turn, and
plans the schedule for that number. A fast device gets the full search; a slow
one gets a shallower one rather than an overrunning turn.

Three things worth knowing:

- **The weights are a ~900 KB download**, so they are deliberately *not* in the
  service worker's install list. Only a player who picks this rung fetches
  them, on selection rather than on the first turn; after that they are cached
  and the rung works offline like everything else. If the fetch fails, the seat
  silently plays Brutal rather than freezing.
- **It plays a free-for-all differently, and deliberately.** The *network*
  generalises to four seats perfectly well. Its *search* does not: the backprop
  assumes a point for me is a point against you, which against three opponents
  is false enough that adding simulations makes the same weights play steadily
  worse — in a Rumble seat against three `hard` bots, 64% wins with no search,
  49% at 8 simulations, 19% at 32 and 16% at 96, where the `hard` bot in the
  same seat wins 26%. So at three seats or more it plays the raw prior plus a
  check for a move that wins on the spot: one evaluation, about 30 ms, and the
  strongest option measured. Two seats get the full search.
- **No teams and no walls.** In Duos a team-mate's tiles land in the *opponent*
  planes of the encoding, so the network would be reading a board that is not
  the one being played. Walls it simply never saw: at a walled four-seat table
  it wins 21% where the `hard` bot it would replace wins 28%. The rung greys out
  in Duos and Chaos (and in a Custom table with either turned on), and any seat
  still set to it falls back to Brutal. Both want their own training run.

## Playing

- **Game speed.** A `1×` / `2×` chip on the home screen (and in the pause card).
  `2×` halves the beat a bot waits before committing and the pace a cascade plays
  back at. It is not a difficulty setting — the bot's search budget is untouched.
- **Planned moves.** Most of a four-way game is spent watching other people think.
  **Double-tap** one of your own tiles while you are waiting and it gets a dashed
  ring; it plays itself the instant your turn comes round. **Tap it again** to
  undo. Only where one seat is yours — in pass-and-play every seat is, so there
  is no wait to plan through.

## The game screen

The HUD is one object, not four corners. Banner, rails, board and share bar sit
together, so a score is always next to the board it counts rather than a couple
of hundred pixels away at the edge of the screen. `fitBoard` shrink-wraps the
canvas to the board **on both axes** for exactly that reason: the chips sit
against the canvas, so whichever axis has slack is exactly how far they get
thrown from the board.

The board is square, so which axis binds depends on the screen — and the HUD
turns to suit:

| Screen | Layout |
|---|---|
| Taller than wide (a phone, a tablet upright) | Rails above and below the board, in a centred column. |
| Wider than tall (a phone on its side, a tablet in landscape, any desktop window) | Rails become columns **beside** the board, which then gets the full height. |
| A roomy touch device playing pass-and-play | Rotated edge seats, one per side, facing outwards. |

- **Rotated edge seats need touch and room.** They exist because the device
  really is being turned around a table — but the two side columns cost the
  board a quarter of its width, which on a 390pt phone is the difference
  between a 366px board and a 277px one. A tablet loses about a tenth and keeps
  them; a phone gets the flat rails and the bigger board; a desktop, where
  nobody rotates the monitor, never sees them.
- **On a wide screen the rails live in the gutters.** A square board on a 16:9
  window leaves several hundred pixels of empty field down each side while the
  scarce axis — height — is what the rails were eating. Turning them through
  ninety degrees uses the space the board cannot.
- The **share bar** under the board is one stacked rail of how much each seat
  holds; whatever is left over is unclaimed board. Two numbers on opposite rails
  never answered "am I winning" at a glance.
- The seat whose **turn it is** inverts to a cream chip with dark ink — rule 4
  of the design language, spent on the one thing on the screen that genuinely
  demands attention.
- The seat this device plays is marked **YOU** — but only when there is one such
  seat, and only when its name does not already say so. In pass-and-play every
  seat is yours, and the marker would say nothing.
- **Scores scale with the screen.** A flat size was one third of a tile on a
  phone and one ninth of one on a monitor; rule 5 says the numbers are the hero
  at every size.

## Mobile, iOS and desktop

Designed at phone width and kept that way: on a desktop the menus sit in one
centred column rather than stretching to 1920px, and the extra room goes to the
things that can use it — the mode picker and the rules run two-up, and the
board grows.

iOS in particular:

- Screens are sized in `dvh` and the field's shading covers `lvh`, so a
  retracting Safari toolbar cannot uncover a strip of bare page beneath them.
- No focusable field is under 16px, because below that Safari zooms the whole
  page in the moment one takes focus.
- Long-press callouts are off over the board and the controls, scrollers do not
  rubber-band the page behind them, and safe-area insets are honoured on every
  screen and overlay.
- `orientation: any` — landscape is a first-class layout, not a fallback.

## Accessibility

- The board canvas is focusable. **Arrow keys** (or WASD) move a cursor, **Enter** or
  **Space** plays the highlighted tile.
- Every control takes a visible focus ring on `:focus-visible`, and hover states
  are behind `(hover: hover)` so a tap never leaves a button stuck lit.
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
- `net.test.mjs` — the online party protocol over a loopback `Peer`: rosters and
  names, ready ticks, what a client is told on start, seat compaction when
  somebody leaves the lobby, and a mid-round drop ending the round but not the
  party. Real WebRTC needs a signalling server and two browsers, which is
  exactly why this layer went untested and exactly why it drifted.
- `nn.test.mjs` — the neural rung against the model it was exported from: the
  encoder must produce identical planes, the forward pass must match PyTorch at
  the precision that ships, and the JS search must reproduce the Python search
  move for move with the noise off. Skips itself if `assets/net/` is absent.

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
| `src/ai.js` | The bot ladder: positional eval + alpha-beta, plus the neural rung. |
| `src/nn.js` | Network inference and board encoding. No dependencies, no build step. |
| `src/nn-bot.js` | Gumbel MCTS over `engine.js`, guided by the network. |
| `assets/net/` | The trained weights (float16) and their manifest. |
| `src/rank.js` | Trophy ladder: ranks, Elo + margin scoring, matchmaking, profile storage. |
| `src/modes.js` | Mode table, seeded mirrored wall generation, per-mode setup. |
| `src/render.js` | Canvas renderer and the cascade animator. |
| `src/icons.js` | Every mark in the app, hand-drawn on one 24×24 grid. No emoji. |
| `src/main.js` | Screens, input, the serial move queue, AI scheduling, online glue. |
| `src/net.js` | PeerJS party rooms: codes, names, ready ticks, rounds, move relay. |
| `src/audio.js` | Synthesised WebAudio SFX — zero audio assets. |
| `index.html` / `styles.css` | Mobile-first shell. |
| `sw.js` / `manifest.webmanifest` / `assets/` | PWA offline cache, installable manifest, icons. |

## Design language

`styles.css` opens with the full statement of it; the short version is six rules:

1. **Extruded, not flat.** Controls sit on a hard, unblurred bottom shadow and a
   top highlight, and collapse into the shadow on press. The highlight is what
   keeps a translucent panel legible as a raised face on a field it is barely
   tinted against. Blur is reserved for things genuinely floating — modals, and
   the board's tiles.
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
