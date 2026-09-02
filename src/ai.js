/**
 * BUST — computer opponents.
 *
 * Pure functions over the engine. `chooseMove` is synchronous but bounded by a
 * wall-clock budget so it never janks a phone mid-turn.
 */

import {
  EMPTY, MAX_BALLS, PHASE_OVER, PHASE_PLACE,
  legalMoves, legalPlacements, applyMove, neighbors, outDegree, idxOf,
} from './engine.js';

export const DIFFICULTIES = {
  easy:   { depth: 0, noise: 3.5,  blunder: 0.22, budgetMs: 60,  label: 'Easy' },
  medium: { depth: 1, noise: 1.0,  blunder: 0.06, budgetMs: 220, label: 'Medium' },
  hard:   { depth: 2, noise: 0.15, blunder: 0.0,  budgetMs: 700, label: 'Hard' },
  brutal: { depth: 3, noise: 0.0,  blunder: 0.0,  budgetMs: 1600, label: 'Brutal' },
};

const WIN = 1e6;

/* ------------------------------------------------------------- evaluation -- */

/**
 * Positional score from `me`'s point of view.
 *
 * The two ideas that matter in this variant:
 *  - A loaded tile (3 balls) sitting next to an enemy loaded tile is a liability:
 *    they bust first and the cascade eats it. Loaded tiles next to *unloaded*
 *    enemies are the opposite — they're a cocked gun.
 *  - Busting on an edge throws balls off the board, so border tiles are cheap to
 *    hold and expensive to attack from. Corners are the safest real estate.
 */
export function evaluate(state, me) {
  if (state.phase === PHASE_OVER) {
    return state.winner === me ? WIN : -WIN;
  }

  const n = state.owner.length;
  const np = state.players.length;
  const material = new Array(np).fill(0);
  let mine = 0;

  for (let i = 0; i < n; i++) {
    const o = state.owner[i];
    if (o === EMPTY) continue;

    const c = state.count[i];
    const deg = outDegree(state, i);
    // Territory is the win condition; balls are the fuel. Border tiles get a
    // small bonus because they are structurally harder to dislodge.
    let v = 1.0 + 0.30 * c + (4 - deg) * 0.45;

    if (c === MAX_BALLS) {
      let threatenedBy = 0;
      let threatens = 0;
      for (const nb of neighbors(state, i)) {
        const no = state.owner[nb];
        if (no === EMPTY || no === o) continue;
        if (state.count[nb] === MAX_BALLS) threatenedBy++;
        else threatens += 1;
      }
      v -= threatenedBy * 2.2;   // they can pop it before we do
      v += threatens * 0.55;     // we're primed to eat them
    }

    material[o] += v;
    if (o === me) mine += 0;
  }

  mine = material[me];
  let bestOpp = -Infinity;
  for (let p = 0; p < np; p++) {
    if (p === me) continue;
    if (!state.players[p].alive && material[p] === 0) continue;
    if (material[p] > bestOpp) bestOpp = material[p];
  }
  if (bestOpp === -Infinity) bestOpp = 0;

  // Measure against the player actually beating us, not the field average —
  // in a 4-player game the runaway leader is the one worth answering.
  return mine - bestOpp;
}

/* ------------------------------------------------------------ opening AI -- */

/**
 * Opening choice: prefer a spot that keeps all four outgoing balls on the board
 * and sits away from the tiles already claimed, without hugging the exact centre
 * (which is the most contested square on the board).
 */
function chooseOpening(state, me, rnd) {
  const moves = legalPlacements(state);
  if (!moves.length) return null;

  const cx = (state.cols - 1) / 2;
  const cy = (state.rows - 1) / 2;
  let best = null;
  let bestScore = -Infinity;

  for (const m of moves) {
    const x = m % state.cols;
    const y = (m / state.cols) | 0;

    // Keeping all 4 balls is worth a lot: a corner opening starts you 2 balls down.
    let s = outDegree(state, m) * 4.0;

    // Elbow room from the middle without being buried in a corner.
    const dCentre = Math.hypot(x - cx, y - cy);
    s -= Math.abs(dCentre - 1.6) * 1.2;

    // Distance from opponents' openings — spread out, don't invite an early brawl.
    for (const s0 of state.starts) {
      if (s0 === null || s0 === undefined) continue;
      const dx = x - (s0 % state.cols);
      const dy = y - ((s0 / state.cols) | 0);
      s += Math.min(Math.hypot(dx, dy), 6) * 0.5;
    }

    s += rnd() * 0.8;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/* ---------------------------------------------------------------- search -- */

function orderedMoves(state, me) {
  const moves = legalMoves(state);
  // Search loaded tiles first — busts are the moves that actually change the
  // position, so they produce the best alpha-beta cuts.
  return moves.sort((a, b) => state.count[b] - state.count[a]);
}

function search(state, me, depth, alpha, beta, deadline) {
  if (state.phase === PHASE_OVER || depth === 0) return evaluate(state, me);
  if (Date.now() > deadline) return evaluate(state, me);

  const moves = orderedMoves(state, state.turn);
  if (!moves.length) return evaluate(state, me);

  const maximizing = state.turn === me;
  let best = maximizing ? -Infinity : Infinity;

  // Cap the branching factor on wide positions; ordering puts the sharp moves first.
  const limit = depth >= 3 ? 10 : depth === 2 ? 16 : moves.length;

  for (const m of moves.slice(0, limit)) {
    const r = applyMove(state, m);
    if (!r.ok) continue;
    const v = search(r.state, me, depth - 1, alpha, beta, deadline);
    if (maximizing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break;
    if (Date.now() > deadline) break;
  }
  return best === Infinity || best === -Infinity ? evaluate(state, me) : best;
}

/* ------------------------------------------------------------------- api -- */

/**
 * Pick a move for the player to act. Returns a tile index, or null if there is
 * nothing legal to do.
 *
 * @param {object} state
 * @param {string} difficulty  key of DIFFICULTIES
 * @param {() => number} [rnd] injectable RNG, for reproducible tests
 */
export function chooseMove(state, difficulty = 'medium', rnd = Math.random) {
  const cfg = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
  const me = state.turn;

  if (state.phase === PHASE_PLACE) return chooseOpening(state, me, rnd);
  if (state.phase === PHASE_OVER) return null;

  const moves = orderedMoves(state, me);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];

  // Easy players sometimes just do something plausible instead of the best thing.
  if (cfg.blunder > 0 && rnd() < cfg.blunder) {
    return moves[Math.floor(rnd() * moves.length)];
  }

  const deadline = Date.now() + cfg.budgetMs;
  let best = moves[0];
  let bestScore = -Infinity;

  for (const m of moves) {
    const r = applyMove(state, m);
    if (!r.ok) continue;
    let v = cfg.depth > 0
      ? search(r.state, me, cfg.depth, -Infinity, Infinity, deadline)
      : evaluate(r.state, me);

    // A move that wins outright always wins the tiebreak.
    if (r.state.phase === PHASE_OVER && r.state.winner === me) return m;

    v += (rnd() - 0.5) * 2 * cfg.noise;
    if (v > bestScore) { bestScore = v; best = m; }
    if (Date.now() > deadline) break;
  }

  return best;
}

/** Human-facing label, e.g. for the settings screen. */
export function difficultyLabel(key) {
  return (DIFFICULTIES[key] || DIFFICULTIES.medium).label;
}
