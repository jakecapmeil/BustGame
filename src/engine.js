/**
 * BUST — pure rules engine.
 *
 * No DOM, no rendering, no randomness. Every function here is deterministic so
 * that the AI can search over it and so that networked clients replaying the
 * same move list always land on byte-identical state.
 *
 * Rules (see README for the long version):
 *  - Each tile holds 0..3 balls and is owned by whoever has balls on it.
 *  - A tile BUSTS the moment it holds a 4th ball: it empties and throws balls
 *    outward, `count - 3` to each of its 4 orthogonal neighbours — one per side
 *    for a 4, two per side for a 5, three for a 6, and so on. Balls aimed off
 *    the board or into a wall are lost, so busting on an edge costs you material.
 *  - A bust can hand a tile several balls at once, so it can be pushed well past
 *    capacity before its own turn to go. Work outwards from the catalyst: a
 *    chain reaction escalates as it spreads.
 *  - Balls landing on a tile capture it for the buster, which can cascade.
 *  - With `bounce` set, a ball thrown at a WALL rebounds onto the tile it left
 *    instead of being lost. The board edge still taxes a bust either way — the
 *    edge is the game's oldest rule, and only walls are opt-in scenery.
 */

export const EMPTY = -1;
export const MAX_BALLS = 3;

export const PHASE_PLACE = 'place';
export const PHASE_PLAY = 'play';
export const PHASE_OVER = 'over';

// Hard ceiling on cascade waves. A bust now throws more balls than it holds
// once a tile is pushed past a 4, so a chain reaction can grow rather than only
// conserve or lose. This ceiling, plus the "one side holds everything" check in
// the loop, keeps a pathological board from spinning forever.
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

/** True if this tile is a wall — it can never hold a ball or be owned. */
export function isBlocked(state, i) {
  return state.blocked ? state.blocked[i] === 1 : false;
}

/**
 * Orthogonal neighbours that can actually receive a ball, ascending.
 * Off-board *and* walled directions are both simply missing, so a ball aimed
 * that way is lost — walls tax a bust exactly the way the board edge does.
 */
export function neighbors(state, i) {
  const { cols, rows } = state;
  const x = i % cols;
  const y = (i / cols) | 0;
  const b = state.blocked;
  const out = [];
  if (y > 0 && (!b || !b[i - cols])) out.push(i - cols);
  if (x > 0 && (!b || !b[i - 1])) out.push(i - 1);
  if (x < cols - 1 && (!b || !b[i + 1])) out.push(i + 1);
  if (y < rows - 1 && (!b || !b[i + cols])) out.push(i + cols);
  return out;
}

/**
 * The on-board orthogonal neighbours of `i` that are walls, ascending.
 *
 * These are exactly the directions a bust throws into and loses — so with
 * bouncy walls on they are the directions whose balls come back.
 */
export function wallNeighbors(state, i) {
  const { cols, rows } = state;
  const b = state.blocked;
  if (!b) return [];
  const x = i % cols;
  const y = (i / cols) | 0;
  const out = [];
  if (y > 0 && b[i - cols]) out.push(i - cols);
  if (x > 0 && b[i - 1]) out.push(i - 1);
  if (x < cols - 1 && b[i + 1]) out.push(i + 1);
  if (y < rows - 1 && b[i + cols]) out.push(i + cols);
  return out;
}

/** How many balls a bust on this tile actually keeps on the board (0..4). */
export function outDegree(state, i) {
  return neighbors(state, i).length;
}

/* ------------------------------------------------------------------ teams -- */

/** Team a player fights for. With no teams set, everyone is their own side. */
export function teamOf(state, pid) {
  return state.teams ? state.teams[pid] : pid;
}

/** Do these two player ids fight on the same side? EMPTY is nobody's friend. */
export function sameTeam(state, a, b) {
  return a !== EMPTY && b !== EMPTY && teamOf(state, a) === teamOf(state, b);
}

/** Every player id sharing the winner's side (just the winner in a free-for-all). */
export function winnersOf(state) {
  if (state.winner === null || state.winner === undefined) return [];
  const t = teamOf(state, state.winner);
  return state.players.filter((p) => teamOf(state, p.id) === t).map((p) => p.id);
}

/* ------------------------------------------------------------------ setup -- */

/**
 * @param {object} opts
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @param {Array<{name:string, kind:'human'|'ai', difficulty?:string}>} opts.players
 * @param {number[]} [opts.teams]     team id per player; omit for a free-for-all
 * @param {ArrayLike<number>} [opts.blocked] 1 per walled tile; omit for an open board
 * @param {boolean} [opts.bounce]    walls rebound balls instead of eating them
 */
export function createGame({ cols, rows, players, teams = null, blocked = null, bounce = false }) {
  const n = cols * rows;
  return {
    cols,
    rows,
    owner: new Int8Array(n).fill(EMPTY),
    count: new Uint8Array(n),
    blocked: blocked ? Uint8Array.from(blocked) : null,
    bounce: !!bounce && !!blocked,
    teams: teams ? Int8Array.from(teams) : null,
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
    // Walls and team assignment never change mid-game, so they are shared.
    blocked: s.blocked,
    bounce: s.bounce,
    teams: s.teams,
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

/**
 * The 3x3 block an opening on `i` would claim, clipped to the board. Walls are
 * left out — they are drawn as walls and were never claimable.
 *
 * The UI uses this to *show* a collision rather than pre-emptively greying out
 * two thirds of the board: an opening round reads better when the board is
 * clean and the conflict only appears at the moment you cause one.
 */
export function openingMask(state, i) {
  const { cols, rows } = state;
  const cx = i % cols;
  const cy = (i / cols) | 0;
  const out = [];
  for (let y = Math.max(0, cy - 1); y <= Math.min(rows - 1, cy + 1); y++) {
    for (let x = Math.max(0, cx - 1); x <= Math.min(cols - 1, cx + 1); x++) {
      const t = y * cols + x;
      if (!isBlocked(state, t)) out.push(t);
    }
  }
  return out;
}

/**
 * Which already-seated players an opening on `i` would collide with.
 * Empty when `i` is illegal for some other reason — chiefly that taking it
 * would strand a player still to open (see `placementFeasible`).
 *
 * @returns {Array<{pid:number, at:number}>}
 */
export function blockingStarts(state, i) {
  const out = [];
  for (let pid = 0; pid < state.starts.length; pid++) {
    const s = state.starts[pid];
    if (s === null || s === undefined) continue;
    if (masksOverlap(state.cols, i, s)) out.push({ pid, at: s });
  }
  return out;
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
function placementFeasible(cols, rows, blocked, starts, remaining, budget) {
  if (remaining <= 0) return true;
  const n = cols * rows;
  for (let i = 0; i < n; i++) {
    if (blocked && blocked[i]) continue;
    if (budget.left-- <= 0) return true; // give up and allow, rather than hang
    let ok = true;
    for (const s of starts) {
      if (masksOverlap(cols, i, s)) { ok = false; break; }
    }
    if (!ok) continue;
    starts.push(i);
    const feasible = placementFeasible(cols, rows, blocked, starts, remaining - 1, budget);
    starts.pop();
    if (feasible) return true;
  }
  return false;
}

/**
 * Tiles the current player may open on.
 *
 * The scan is greedy-first (it always tries the lowest free index), which seats
 * a full table on the first descent in every realistic position; the node
 * budget only exists so a pathological board can never wedge the UI thread.
 */
export function legalPlacements(state) {
  const n = state.cols * state.rows;
  const taken = state.starts.filter((s) => s !== null && s !== undefined);
  // Openings still needed after this one.
  const remaining = state.players.length - taken.length - 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (isBlocked(state, i)) continue;
    if (conflictsWithStarts(state, i)) continue;
    // Don't let an opening strand a later player with nowhere legal to go.
    if (remaining > 0) {
      const budget = { left: 20000 };
      if (!placementFeasible(state.cols, state.rows, state.blocked, [...taken, i], remaining, budget)) continue;
    }
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

/** The only team still holding tiles, or -1 if more than one is left. */
function soleSurvivingTeam(state) {
  let found = -1;
  for (let i = 0; i < state.owner.length; i++) {
    const o = state.owner[i];
    if (o === EMPTY) continue;
    const t = teamOf(state, o);
    if (found === -1) found = t;
    else if (found !== t) return -1;
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
    // Once a single side holds every ball on the board the cascade is
    // decided; stopping here also rules out a runaway loop on a full board,
    // where escalating busts could otherwise ping-pong without end.
    if (soleSurvivingTeam(state) !== -1 && !opening) break;

    const wave = [...new Set(pending)].sort((a, b) => a - b);
    // How hard a tile blows scales with how far past a 4 it was pushed: a 4
    // throws one ball per side, a 5 two, a 6 three (`count - MAX_BALLS`). Balls
    // aimed off the board are simply lost; balls aimed into a wall are lost too
    // unless `bounce` is on, in which case they come back (`back` / `keep`).
    const busts = wave.map((i) => {
      const n = state.count[i] - MAX_BALLS;
      const back = state.bounce ? wallNeighbors(state, i) : [];
      return {
        at: i,
        player: state.owner[i],
        to: neighbors(state, i),
        n,
        back,
        // Capped at capacity: a rebound puts balls back on the tile, it never
        // re-detonates it on its own. Without that cap a tile with one exit
        // keeps 3x what it throws and the cascade never terminates.
        keep: back.length ? Math.min(MAX_BALLS, back.length * n) : 0,
      };
    });

    // Empty every bursting tile before distributing, so two adjacent tiles
    // bursting in the same wave hand each other their balls cleanly.
    for (const i of wave) { state.owner[i] = EMPTY; state.count[i] = 0; }

    // Rebounds land before the outgoing balls do, so a tile that kept some of
    // its own can still be captured by a neighbour bursting in the same wave.
    for (const b of busts) {
      if (b.keep <= 0) continue;
      state.owner[b.at] = b.player;
      state.count[b.at] = b.keep;
    }

    const next = new Set();
    for (const b of busts) {
      for (const t of b.to) {
        // Balls landing on a team-mate reinforce their tile without stealing
        // it; anything else is captured outright.
        if (!sameTeam(state, state.owner[t], b.player)) state.owner[t] = b.player;
        state.count[t] += b.n;
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
    // A side is out only when every one of its players is out, so a partner can
    // carry the team.
    const aliveTeams = new Set(alive.map((p) => teamOf(state, p.id)));
    if (aliveTeams.size <= 1) {
      state.phase = PHASE_OVER;
      // `winner` is a representative of the winning side; `winnersOf(state)`
      // expands it to the whole team.
      state.winner = alive.length ? alive[0].id : player;
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
