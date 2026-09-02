/**
 * BUST — pure rules engine.
 *
 * No DOM, no rendering, no randomness. Every function here is deterministic so
 * that the AI can search over it and so that networked clients replaying the
 * same move list always land on byte-identical state.
 *
 * Rules (see README for the long version):
 *  - Each tile holds 0..3 balls and is owned by whoever has balls on it.
 *  - Adding a 4th ball to a tile BUSTS it: the tile empties and sends exactly
 *    one ball to each of its 4 orthogonal neighbours. Balls aimed off the board
 *    are lost, so busting on an edge or in a corner costs you material.
 *  - Balls landing on a tile capture it for the buster, which can cascade.
 */

export const EMPTY = -1;
export const MAX_BALLS = 3;

export const PHASE_PLACE = 'place';
export const PHASE_PLAY = 'play';
export const PHASE_OVER = 'over';

// Hard ceiling on cascade waves. A cascade can never gain balls (interior busts
// conserve, edge busts lose), so this is a safety net rather than a rule.
const MAX_WAVES = 2000;

/* ------------------------------------------------------------------ board -- */

export function idxOf(state, x, y) {
  return y * state.cols + x;
}
export function xOf(state, i) {
  return i % state.cols;
}
export function yOf(state, i) {
  return (i / state.cols) | 0;
}

/** Orthogonal in-bounds neighbours, always in ascending index order. */
export function neighbors(state, i) {
  const { cols, rows } = state;
  const x = i % cols;
  const y = (i / cols) | 0;
  const out = [];
  if (y > 0) out.push(i - cols);
  if (x > 0) out.push(i - 1);
  if (x < cols - 1) out.push(i + 1);
  if (y < rows - 1) out.push(i + cols);
  return out;
}

/** How many balls a bust on this tile actually keeps on the board (2..4). */
export function outDegree(state, i) {
  const { cols, rows } = state;
  const x = i % cols;
  const y = (i / cols) | 0;
  return (x > 0 ? 1 : 0) + (x < cols - 1 ? 1 : 0) + (y > 0 ? 1 : 0) + (y < rows - 1 ? 1 : 0);
}

/* ------------------------------------------------------------------ setup -- */

/**
 * @param {object} opts
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @param {Array<{name:string, kind:'human'|'ai', difficulty?:string}>} opts.players
 */
export function createGame({ cols, rows, players }) {
  const n = cols * rows;
  return {
    cols,
    rows,
    owner: new Int8Array(n).fill(EMPTY),
    count: new Uint8Array(n),
    players: players.map((p, i) => ({
      id: i,
      name: p.name,
      kind: p.kind,
      difficulty: p.difficulty || 'medium',
      alive: true,
      placed: false,
    })),
    turn: 0,
    phase: PHASE_PLACE,
    starts: [], // tile index each player opened on, parallel to players
    turnNumber: 0,
    winner: null,
  };
}

export function cloneGame(s) {
  return {
    cols: s.cols,
    rows: s.rows,
    owner: s.owner.slice(),
    count: s.count.slice(),
    players: s.players.map((p) => ({ ...p })),
    turn: s.turn,
    phase: s.phase,
    starts: s.starts.slice(),
    turnNumber: s.turnNumber,
    winner: s.winner,
  };
}

/* ------------------------------------------------------------- placement -- */

/**
 * Opening masks may not overlap. Each opening claims the 3x3 block centred on
 * the chosen tile, so two openings collide exactly when they are within 2 tiles
 * on both axes.
 */
function masksOverlap(cols, a, b) {
  const dx = Math.abs((a % cols) - (b % cols));
  const dy = Math.abs(((a / cols) | 0) - ((b / cols) | 0));
  return dx <= 2 && dy <= 2;
}

function conflictsWithStarts(state, i) {
  for (const s of state.starts) {
    if (s !== null && s !== undefined && masksOverlap(state.cols, i, s)) return true;
  }
  return false;
}

/**
 * Can `remaining` further openings still be seated given `starts` already
 * taken? Backtracking search — the board is small (<= 81 tiles) and remaining
 * is at most 3, so this is cheap and runs on every legality query.
 */
function placementFeasible(cols, rows, starts, remaining) {
  if (remaining <= 0) return true;
  const n = cols * rows;
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const s of starts) {
      if (masksOverlap(cols, i, s)) { ok = false; break; }
    }
    if (!ok) continue;
    starts.push(i);
    const feasible = placementFeasible(cols, rows, starts, remaining - 1);
    starts.pop();
    if (feasible) return true;
  }
  return false;
}

/** Tiles the current player may open on. */
export function legalPlacements(state) {
  const n = state.cols * state.rows;
  const taken = state.starts.filter((s) => s !== null && s !== undefined);
  // Openings still needed after this one.
  const remaining = state.players.length - taken.length - 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (conflictsWithStarts(state, i)) continue;
    // Don't let an opening strand a later player with nowhere legal to go.
    if (remaining > 0 && !placementFeasible(state.cols, state.rows, [...taken, i], remaining)) continue;
    out.push(i);
  }
  return out;
}

/* ------------------------------------------------------------------ moves -- */

/** Tiles the current player may click during normal play. */
export function legalMoves(state) {
  if (state.phase === PHASE_PLACE) return legalPlacements(state);
  if (state.phase !== PHASE_PLAY) return [];
  const me = state.turn;
  const out = [];
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] === me) out.push(i);
  }
  return out;
}

export function isLegalMove(state, i) {
  if (!Number.isInteger(i) || i < 0 || i >= state.owner.length) return false;
  if (state.phase === PHASE_PLACE) return legalPlacements(state).includes(i);
  if (state.phase === PHASE_PLAY) return state.owner[i] === state.turn;
  return false;
}

function tilesOwnedBy(state, p) {
  let t = 0;
  for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === p) t++;
  return t;
}

export function scores(state) {
  const tiles = new Array(state.players.length).fill(0);
  const balls = new Array(state.players.length).fill(0);
  for (let i = 0; i < state.owner.length; i++) {
    const o = state.owner[i];
    if (o !== EMPTY) { tiles[o]++; balls[o] += state.count[i]; }
  }
  return { tiles, balls };
}

/** Index of the only surviving player, or -1 if more than one is left. */
function soleSurvivor(state) {
  let found = -1;
  for (let i = 0; i < state.owner.length; i++) {
    const o = state.owner[i];
    if (o === EMPTY) continue;
    if (found === -1) found = o;
    else if (found !== o) return -1;
  }
  return found;
}

function snapshot(state) {
  return { owner: state.owner.slice(), count: state.count.slice() };
}

function advanceTurn(state) {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const next = (state.turn + step) % n;
    if (state.players[next].alive) { state.turn = next; return; }
  }
}

/**
 * Play a move. Returns the new state plus an animation script; the caller's
 * state is never mutated.
 *
 * frames[0] is always the board right after the ball is placed. Each later
 * frame is one cascade wave: `busts` lists the tiles that blew up entering that
 * frame and where their balls flew, and `owner`/`count` are the board once that
 * wave has fully landed.
 *
 * @returns {{state: object, frames: Array, ok: boolean, reason?: string}}
 */
export function applyMove(prev, moveIdx) {
  if (!isLegalMove(prev, moveIdx)) {
    return { state: prev, frames: [], ok: false, reason: 'illegal' };
  }

  const state = cloneGame(prev);
  const player = state.turn;
  const opening = state.phase === PHASE_PLACE;
  const frames = [];

  if (opening) {
    // An opening tile is dropped in already over capacity, so it busts on the spot.
    state.owner[moveIdx] = player;
    state.count[moveIdx] = MAX_BALLS + 1;
    state.starts[player] = moveIdx;
    state.players[player].placed = true;
  } else {
    state.owner[moveIdx] = player;
    state.count[moveIdx] += 1;
  }

  frames.push({ kind: opening ? 'open' : 'place', at: moveIdx, player, busts: [], ...snapshot(state) });

  // --- cascade -------------------------------------------------------------
  let pending = state.count[moveIdx] > MAX_BALLS ? [moveIdx] : [];
  let waves = 0;

  while (pending.length && waves++ < MAX_WAVES) {
    // Once a single player holds every ball on the board the cascade is
    // decided; stopping here also rules out a runaway loop on a full board,
    // where interior busts conserve balls and could otherwise ping-pong.
    if (soleSurvivor(state) !== -1 && !opening) break;

    const wave = [...new Set(pending)].sort((a, b) => a - b);
    const busts = wave.map((i) => ({ at: i, player: state.owner[i], to: neighbors(state, i) }));

    // Empty every bursting tile before distributing, so two adjacent tiles
    // bursting in the same wave correctly hand each other a single ball.
    for (const i of wave) { state.owner[i] = EMPTY; state.count[i] = 0; }

    const next = new Set();
    for (const b of busts) {
      for (const t of b.to) {
        state.owner[t] = b.player;
        state.count[t] += 1;
        if (state.count[t] > MAX_BALLS) next.add(t);
      }
    }

    frames.push({ kind: 'wave', busts, ...snapshot(state) });
    pending = [...next];
  }

  // If we bailed out of the cascade early (game already decided, or the wave
  // ceiling tripped) some tiles can still be sitting over capacity. Settle them
  // so the board handed back is always a legal position.
  if (pending.length) {
    let clamped = false;
    for (let i = 0; i < state.count.length; i++) {
      if (state.count[i] > MAX_BALLS) { state.count[i] = MAX_BALLS; clamped = true; }
    }
    if (clamped) frames.push({ kind: 'settle', busts: [], ...snapshot(state) });
  }

  // --- bookkeeping ---------------------------------------------------------
  state.turnNumber += 1;

  if (opening) {
    const everyoneOpened = state.players.every((p) => p.placed);
    if (everyoneOpened) state.phase = PHASE_PLAY;
  }

  if (state.phase === PHASE_PLAY) {
    // Elimination only applies once the opening round is complete, so a player
    // is never knocked out before they have had a chance to play.
    for (const p of state.players) {
      if (p.alive && tilesOwnedBy(state, p.id) === 0) p.alive = false;
    }
    const alive = state.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      state.phase = PHASE_OVER;
      state.winner = alive.length === 1 ? alive[0].id : player;
    }
  }

  if (state.phase !== PHASE_OVER) advanceTurn(state);

  return { state, frames, ok: true };
}

/** Board with no cascade animation — used by the AI's search. */
export function applyMoveFast(prev, moveIdx) {
  return applyMove(prev, moveIdx).state;
}

export function currentPlayer(state) {
  return state.players[state.turn];
}
