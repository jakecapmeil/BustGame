# Prompt for Fable 5.1 — polish BUST's UI end to end

You are working on **BUST**, a finished-but-rough mobile-first PWA board game.
Your job is a **UI/UX polish pass**: fix every visual and interaction problem
below, then take the whole app from "functional" to "shippable". Do not rewrite
the game — refine it.

---

## 1. What the app is

- A tactical chain-reaction board game. Load a tile past 3 balls, it **busts**
  and fires a ball to each neighbour, stealing what they land on. Wipe every
  other colour to win.
- **Stack:** vanilla ES modules, a single `<canvas>` board, **no build step, no
  framework, no dependencies**. Served as static files.
- **Files you will touch:** `index.html`, `styles.css`, `src/render.js`
  (canvas renderer + animator), `src/main.js` (screens, input, HUD),
  `src/icons.js` (hand-drawn SVG marks), `src/modes.js`, `src/rank.js` (only its
  DOM-facing bits). Read `README.md` and `HANDOFF.md` first — they explain the
  design language and history.
- **Primary target:** iPhone-class viewport, **375 × 812**. Also verify 320-wide
  and a short landscape.

## 2. Hard constraints — do not break these

- **Do not modify `src/engine.js`.** It is pure, deterministic and fully tested.
- **Do not weaken, skip or delete tests.** `node --test test/*.test.mjs` must
  stay green before and after your work.
- **No build step. No new runtime dependencies.** Fonts already load from Google
  Fonts; everything else is local.
- **Keep the design language** stated at the top of `styles.css` (extruded not
  flat; one accent per screen; big/round/confident; invert to focus; numbers are
  the hero; motion is physical; every mark hand-drawn, no emoji). Themes are
  swapped only via `<html data-theme>` palette blocks — keep that mechanism, and
  keep the canvas reading its skin from the same CSS custom properties
  (`setBoardSkin`).
- **Honour `prefers-reduced-motion`** and keep the `aria-live` / keyboard-cursor
  accessibility path working.
- Keep it a PWA: `manifest.webmanifest`, `sw.js`, offline solo play all keep
  working. Bump `CACHE` in `sw.js` if you change cached assets.

## 3. Concrete issues to fix (found on-device at 375×812)

### 3.1 Global / theme
- The whole app is a low-contrast wash of one hue. Panels
  (`--panel`, `--panel-2`) barely separate from `--bg`, so every non-card screen
  reads as muddy. Increase surface separation: stronger top highlight, a real
  (subtle) border or shadow, slightly more panel tint — without abandoning the
  "extruded" look. The cream **cards** (pause/over/lose) are the quality bar the
  rest of the app should get closer to.
- Body copy set in `--on-bg-dim` at weight 700 fails contrast on several themes
  (ember, blaze, gild especially). Raise minimum body contrast to WCAG AA;
  re-check all 7 themes (`ember, tide, orchid, blaze, gild, toxic, slate`).
- The `.icon-btn` menu (hamburger) in-game and the `Back` buttons are nearly
  invisible against the field. Give icon buttons a legible face on every theme.
- Ghost buttons (`.btn-ghost`, "How to play", "Change mode") are so faint they
  look disabled. Make secondary actions clearly tappable.

### 3.2 Home screen
- The `.rank-strip` progress track at 0 trophies renders as a thin empty pill
  that looks like a stray horizontal line / rendering glitch. Give the empty
  track a visible-but-quiet fill state, or a min fill nub.
- Vertical rhythm: logo → tagline → rank strip → mode hero → menu → toggles feels
  loosely stacked. Tighten into a deliberate composition; the tagline line-break
  is awkward.

### 3.3 Setup screens (Solo / Local / Online)
- Huge dead vertical band between the top control cluster and the pinned bottom
  primary button (Solo screen is the worst — ~40% of the screen is empty). Either
  vertically centre the content, add supporting content (a mode preview / mini
  board / "what you're about to play" summary card), or size the screen to its
  content. Make every setup screen feel intentional, not half-empty.
- The "Bot difficulty" segmented control on Solo is a single lonely row — give the
  screen more shape (e.g. a short description of the selected difficulty).

### 3.4 Ranked screen — has a real bug
- On open, `renderRankedScreen()` auto-scrolls the ladder so "your rank" is
  centred. When the content above (rank hero badge, trophy count, progress bar,
  next-rank line, the Played/Win-rate/Best stat row) **would fit**, it still
  scrolls it off the top — you land on the screen looking at a clipped stat row
  with the numbers cut off by the scroll mask, and the hero is gone. Fix so the
  hero is always visible on entry and the ladder only scrolls-to-rank when it
  genuinely overflows. Add a top fade mask to match the bottom one, or avoid the
  hard clip entirely.
- Locked ladder rows at `opacity: .66` on an already low-contrast panel are
  barely readable. Improve locked/unlocked/here styling so the ladder is a
  legible, satisfying progression (this is a retention screen — make it feel
  aspirational).
- Rank badge tints are the only colour on the screen and they're tiny; lean into
  them.

### 3.5 Mode picker
- Best screen in the app — keep the per-theme cards. But:
  - The currently-selected card is painted identical to the page background and
    reads as a hole; make "selected" unambiguous beyond the thin outline.
  - Redundant text: `"4-player free-for-all · 4p · 8×8"`, `"One on one · 2p ·
    7×7"` — the tagline and the `Np` repeat. Collapse to one clean descriptor.
  - Tagline/desc contrast varies wildly by card theme (Duos/Custom weak, Chaos
    fine). Normalise so every card's secondary text is readable.
  - Dead space above "Done".

### 3.6 How-to-play screen
- Wall of pale prose, cards barely distinct from background, no visuals for a
  game that is entirely about a **visual** chain reaction. Add small hand-drawn
  diagrams (same `icons.js` two-tone style, or tiny inline SVG board snippets):
  at minimum show a tile busting into 4 neighbours, the edge tax, and "a loaded
  tile has a ring". Raise text contrast. Make it skimmable.

### 3.7 In-game HUD (the core screen)
- **Canvas focus outline:** when the board has focus (keyboard play, or just
  after a tap on some browsers) `#board:focus-visible` draws a hard white
  rectangle around the entire canvas — looks like a selection artifact. Replace
  with a focus treatment that reads as "the board is focused" without a full
  white border (e.g. a soft inset glow, or only show the in-canvas cursor ring).
- **Board is too small.** A 7×7 on an 812-tall screen leaves a ~300px empty band
  below the bottom score chip. `fitBoard()` / the `.is-crowded` column should let
  the board grow to use the available height; the HUD cluster should sit
  centred with the board as the dominant element.
- **The "one HUD object" intent isn't landing.** Turn banner, opponent chip, and
  your chip float as three separate pills with uneven gaps above/around the
  board. Group them tightly to the board (consistent spacing, shared visual
  container or rhythm) so the readout moves as one block.
- **Share bar** (the stacked ownership rail under the board): during the opening
  round and early game it's a long dark empty trough that reads as a broken
  loading bar. Give "unclaimed board" a proper neutral fill (tile colour, not the
  `--sink` void), round the segment ends, and reconsider its height/prominence
  vs. how much it communicates.
- **Legal-move hint** on tiles is a ~30%-opacity white pulse that is almost
  invisible, so a new player on the opening screen sees a blank grid and only the
  text banner tells them what to do. Make legal tiles clearly, invitingly
  tappable (stronger ring, subtle fill, or a bounce) while still calm during
  normal play.
- Score chips and the menu button need more contrast (see 3.1).
- Verify the **cascade animation** actually reads well: flying balls, the
  bursting tile collapse, the per-tile landing shock ring, and the pre-bust
  wind-up (swell + shake + ring). Tune timing/easing so a 5+ wave chain is
  exciting, legible, and never feels slow or janky. Confirm it still resolves
  every time (there was a historical freeze bug — see HANDOFF.md).

### 3.8 Game-over / result card
- `.tally-total`: the rank badge is jammed against the trophy count with no
  breathing room and is optically too big / misaligned next to 22px text. Fix
  spacing and vertical alignment; size the badge to the number.
- The breakdown list sits directly under the progress bar and directly above
  "Play again" with no rhythm — flat 10px gaps everywhere kill the hierarchy.
  Give the card real vertical structure: hero result → delta → new total+rank →
  progress → breakdown (spaced) → actions.
- The `.winner-disc` (two box-shadow pips) reads like an ellipsis/hamburger, not
  a trophy moment. Make the win token feel like a reward (use the seat colour +
  a spark/among the icon family).
- Do the same spacing/hierarchy polish on the **"YOU LOSE"** (`#overlay-out`)
  card.

### 3.9 Motion & feel
- Screen transitions are a single 8px translate/fade — fine but generic. Add
  restrained, physical polish (shared-element feel between the mode hero and the
  mode screen, the rank strip and the ranked screen) within the existing
  easing tokens.
- Every button already has a press state — audit that all interactive elements
  (chips, ladder rows, segmented buttons, cards) have a consistent, satisfying
  pressed/active response.

## 4. Definition of done

1. `node --test test/*.test.mjs` passes (add tests only if you add behaviour).
2. Every issue in §3 addressed, verified at **375×812**, plus a sanity check at
   320-wide and short landscape.
3. All **7 themes** checked: no unreadable text, no invisible controls, board
   skin matches chrome.
4. A full solo game plays start→finish: opening, multi-wave cascade, elimination,
   "you lose" card, game-over card with trophy tally, play-again, quit-to-menu —
   all correct and good-looking.
5. `prefers-reduced-motion` still removes animation; keyboard board cursor and
   `aria-live` announcements still work.
6. No new console errors/warnings. No layout that scrolls horizontally.
7. PWA still installs and plays offline (bump `sw.js` `CACHE` if assets changed).

## 5. How to work

- Serve locally: `python3 -m http.server 8000` from the repo root, open at
  375×812. (There is a `.claude/launch.json` named `bust` on port 8731.)
- Make focused commits per screen/area with before/after notes.
- When a fix is a judgement call, prefer the choice that makes the app feel like
  a polished commercial mobile game (Clash-Royale-tier chrome) while staying
  true to the stated design language.
- Deliver a short changelog of what you changed and why, plus any issue you
  chose **not** to fix and the reason.
