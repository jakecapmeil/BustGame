/**
 * BUST — game modes.
 *
 * A mode is the *shape* of a match: how many seats, how big the board, whether
 * seats are paired into teams, and whether the map has walls. It is orthogonal
 * to how you play it (solo / local / online) and to ranked scoring.
 *
 * Each mode also names a theme, which swaps the whole app's palette via
 * `document.documentElement.dataset.theme`, and an `icon`, which is the key of
 * a hand-drawn mark in `icons.js`. Modes are data, not code — adding one is a
 * single entry here, a `[data-theme]` block in styles.css, and one icon.
 *
 * Wall generation lives here rather than in the engine so the engine stays
 * free of randomness: `makeWalls` is seeded and deterministic, and the caller
 * hands the finished mask to `createGame({ blocked })`.
 */

import { createGame, legalPlacements, applyMove } from './engine.js';

/* ------------------------------------------------------------------ modes -- */

export const MODES = {
  duel: {
    key: 'duel', name: 'Duel', tagline: 'One on one',
    blurb: 'The purest version. Two colours, a small board, nowhere to hide.',
    seats: 2, board: [7, 7], teams: null, wallDensity: 0, theme: 'ember', icon: 'duel',
  },
  rumble: {
    key: 'rumble', name: 'Rumble', tagline: '4-player free-for-all',
    blurb: 'Four colours, one board. Everyone for themselves.',
    seats: 4, board: [8, 8], teams: null, wallDensity: 0, theme: 'tide', icon: 'rumble',
  },
  arena: {
    key: 'arena', name: 'Big Arena', tagline: '4 players · big map',
    blurb: 'The same four-way brawl with room to manoeuvre — and longer chains.',
    seats: 4, board: [10, 10], teams: null, wallDensity: 0, theme: 'orchid', icon: 'arena',
  },
  mayhem: {
    key: 'mayhem', name: 'Mayhem', tagline: '8 players · big map',
    blurb: 'Eight colours on a huge board. Total chaos, and only one survivor.',
    seats: 8, board: [12, 12], teams: null, wallDensity: 0, theme: 'blaze', icon: 'mayhem',
  },
  duos: {
    key: 'duos', name: 'Duos', tagline: 'Play in pairs',
    blurb: 'Partners share a win. Busts feed your team-mate instead of stealing from them.',
    seats: 4, board: [10, 10], teams: [0, 1, 0, 1], wallDensity: 0, theme: 'gild', icon: 'duos',
  },
  chaos: {
    key: 'chaos', name: 'Chaos', tagline: 'A mirrored maze',
    blurb: 'A mirrored maze of walls. Balls fired into a wall are gone — pick your angles.',
    seats: 4, board: [10, 10], teams: null, wallDensity: 0.13, theme: 'toxic', icon: 'chaos',
  },
  custom: {
    key: 'custom', name: 'Custom', tagline: 'Your rules',
    blurb: 'Set the table size, the board, teams and walls yourself.',
    seats: 4, board: [8, 8], teams: null, wallDensity: 0, bounceWalls: false,
    theme: 'slate', icon: 'custom',
  },
};

export const MODE_ORDER = ['duel', 'rumble', 'arena', 'mayhem', 'duos', 'chaos', 'custom'];

export const MAX_SEATS = 8;

export function modeFor(key) {
  return MODES[key] || MODES.duel;
}

/* ------------------------------------------------------------------ walls -- */

const mulberry32 = (a) => () => {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A mirrored wall mask. Walls are generated in the top-left quadrant only and
 * reflected across both axes, so no seat gets a structurally better corner —
 * the same reason competitive shooters mirror their maps.
 */
export function makeWalls({ cols, rows, density, seed }) {
  const blocked = new Uint8Array(cols * rows);
  if (!density) return blocked;
  const rnd = mulberry32(seed);
  const target = Math.floor(cols * rows * density);
  const halfC = Math.ceil(cols / 2);
  const halfR = Math.ceil(rows / 2);

  let placed = 0;
  for (let guard = 0; placed < target && guard < 400; guard++) {
    const x = Math.floor(rnd() * halfC);
    const y = Math.floor(rnd() * halfR);
    const len = 1 + Math.floor(rnd() * 3);       // short blobs read as walls, not static
    const horiz = rnd() < 0.5;
    for (let k = 0; k < len; k++) {
      const bx = Math.min(halfC - 1, x + (horiz ? k : 0));
      const by = Math.min(halfR - 1, y + (horiz ? 0 : k));
      for (const [mx, my] of [
        [bx, by], [cols - 1 - bx, by], [bx, rows - 1 - by], [cols - 1 - bx, rows - 1 - by],
      ]) {
        const i = my * cols + mx;
        if (!blocked[i]) { blocked[i] = 1; placed++; }
      }
    }
  }
  return blocked;
}

/**
 * Walls that are *playable*: every seat must still have a legal opening, and a
 * full opening round must be seatable. Tries a few seeds, then gives up and
 * returns an open board rather than dealing an unplayable map.
 */
export function makePlayableWalls({ cols, rows, density, seats, seed = Date.now() }) {
  if (!density) return null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const blocked = makeWalls({ cols, rows, density, seed: (seed + attempt * 7919) | 0 });
    if (canSeatEveryone({ cols, rows, seats, blocked })) return blocked;
  }
  return null;
}

/** Dry-run the opening round to prove every seat has somewhere to go. */
function canSeatEveryone({ cols, rows, seats, blocked }) {
  const players = Array.from({ length: seats }, (_, i) => ({ name: `P${i}`, kind: 'ai' }));
  let s = createGame({ cols, rows, players, blocked });
  for (let k = 0; k < seats; k++) {
    const opts = legalPlacements(s);
    if (!opts.length) return false;
    s = applyMove(s, opts[0]).state;
  }
  return true;
}

/* ------------------------------------------------------------------ setup -- */

/**
 * Turn a mode (plus any custom overrides) into everything `createGame` needs.
 * `seed` makes the walls reproducible, which is what lets an online host send
 * one number instead of a whole map.
 *
 * @returns {{cols, rows, seats, teams, blocked, bounce, seed, mode}}
 */
export function buildSetup(modeKey, custom = null, seed = Date.now()) {
  const mode = modeFor(modeKey);
  const cfg = modeKey === 'custom' && custom ? { ...mode, ...custom } : mode;
  const [cols, rows] = cfg.board;
  const seats = Math.max(2, Math.min(MAX_SEATS, cfg.seats));
  const teams = cfg.teams ? cfg.teams.slice(0, seats) : null;
  const blocked = makePlayableWalls({ cols, rows, density: cfg.wallDensity, seats, seed });
  return { cols, rows, seats, teams, blocked, bounce: !!(cfg.bounceWalls && blocked), seed, mode: cfg };
}

/**
 * The smallest board that seats this many players without the opening round
 * eating the whole map. Openings claim a 3x3 zone apiece and may not overlap,
 * so the seat count sets a hard floor on the board no matter which mode's map
 * is being played.
 */
export function minBoardFor(seats) {
  if (seats <= 2) return 7;
  if (seats <= 4) return 8;
  if (seats <= 6) return 10;
  return 12;
}

/**
 * A setup for an online party: the *mode* supplies the map (board size, teams,
 * walls) and the *party* supplies the seat count.
 *
 * Online is about getting a group together and then playing round after round,
 * so the room is not capped at whatever the mode happens to seat — the table
 * grows to the party and the board grows with it. Teams need an even table, so
 * an odd party plays the same map free-for-all.
 *
 * @returns {{cols, rows, seats, teams, blocked, bounce, seed, mode}}
 */
export function buildPartySetup(modeKey, custom = null, partySeats = 2, seed = Date.now()) {
  const mode = modeFor(modeKey);
  const cfg = modeKey === 'custom' && custom ? { ...mode, ...custom } : mode;
  const seats = Math.max(2, Math.min(MAX_SEATS, partySeats));
  const n = Math.max(cfg.board[0], minBoardFor(seats));
  const teams = cfg.teams && seats % 2 === 0
    ? Array.from({ length: seats }, (_, i) => i % 2) : null;
  const blocked = makePlayableWalls({ cols: n, rows: n, density: cfg.wallDensity, seats, seed });
  return {
    cols: n, rows: n, seats, teams, blocked,
    bounce: !!(cfg.bounceWalls && blocked), seed, mode: cfg,
  };
}

/**
 * Human-readable one-liner for a setup, e.g. "4 seats · 10×10 · walls".
 *
 * `compact` shortens "4 seats" to "4p" — the mode cards put this after a
 * tagline on one line, and the long form pushed the last fact (usually the one
 * that matters, "walls") off the end into an ellipsis.
 */
export function describeSetup(cfg, compact = false) {
  const bits = [compact ? `${cfg.seats}p` : `${cfg.seats} seats`, `${cfg.board[0]}×${cfg.board[1]}`];
  if (cfg.teams) bits.push('2v2');
  if (cfg.wallDensity) bits.push(cfg.bounceWalls ? (compact ? 'bounce' : 'bouncy walls') : 'walls');
  return bits.join(' · ');
}
