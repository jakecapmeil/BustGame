/**
 * BUST — the neural opponent.
 *
 * Gumbel AlphaZero search (Danihelka et al., 2022) over `engine.js`, guided by
 * the policy+value network in `nn.js`. This is the same search the network was
 * trained with, so what it learned in training is what it plays here.
 *
 * Why Gumbel rather than plain PUCT: it is built for tiny simulation budgets.
 * The root samples Gumbel noise over the prior, keeps the best handful of moves
 * and spends the budget on them by sequential halving, which gives a genuine
 * policy improvement at a few dozen simulations, where PUCT would still be
 * flailing. That matters because the budget here is a phone's turn, not a
 * datacentre's.
 *
 * Every value is stored from the point of view of the seat to move at that
 * node, and backprop compares `toPlay` rather than assuming the seats
 * alternate — BUST breaks alternation in two places, since eliminated seats are
 * skipped and the winner is still "to move" at a finished position.
 */

import {
  PHASE_OVER, legalMoves, applyMoveFast, sameTeam,
} from './engine.js';
import { encode } from './nn.js';

/**
 * Ready-made settings. `sims` is the *ceiling* on simulations and `budgetMs` is
 * the wall clock; the bot works out how many of those simulations this device
 * can actually afford and plans the schedule for that number, so a laptop gets
 * the full search and a slow phone degrades to a shallower one instead of
 * overrunning its turn.
 */
export const NEURAL_PRESETS = {
  fast:   { sims: 32, mTop: 8,  budgetMs: 600 },
  normal: { sims: 96, mTop: 12, budgetMs: 1400 },
  deep:   { sims: 256, mTop: 16, budgetMs: 4000 },
};

const gumbel = (rnd) => -Math.log(-Math.log(rnd() + 1e-12) + 1e-12);

function softmax(scores) {
  let m = -Infinity;
  for (const s of scores) if (s > m) m = s;
  let t = 0;
  const e = new Array(scores.length);
  for (let i = 0; i < scores.length; i++) { e[i] = Math.exp(scores[i] - m); t += e[i]; }
  for (let i = 0; i < e.length; i++) e[i] /= t;
  return e;
}

function ownsAnything(state, seat) {
  for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === seat) return true;
  return false;
}

function makeNode(state) {
  return {
    state,
    toPlay: state.turn,
    terminal: state.phase === PHASE_OVER,
    termValue: state.phase === PHASE_OVER ? (state.turn === state.winner ? 1 : -1) : 0,
    expanded: false,
    moves: null,
    logits: null,
    children: null,
    N: 0,
    W: 0,
  };
}

export class NeuralBot {
  /**
   * @param {import('./nn.js').BustNet} net
   * @param {{sims?:number, mTop?:number, budgetMs?:number, noise?:boolean}} [opts]
   */
  constructor(net, opts = {}) {
    const cfg = { ...NEURAL_PRESETS.normal, ...opts };
    this.net = net;
    this.sims = cfg.sims;
    this.mTop = cfg.mTop;
    this.budgetMs = cfg.budgetMs;
    // A little noise keeps a bot from playing the identical game every time.
    this.noise = cfg.noise !== false;
    this.cVisit = 50;
    this.cScale = 1;
    this.lastValue = 0;
    this.lastSims = 0;
    this.plannedSims = cfg.sims;
    // Rolling cost of one network evaluation on this device, measured rather
    // than assumed — it varies by an order of magnitude between a laptop and a
    // budget phone, and it is what decides how deep the search can go.
    this.msPerEval = 0;
    // Candidates to look a ply ahead for at a wider table; 0 plays the prior
    // straight. See `_onePly`.
    this.ffaLookahead = cfg.ffaLookahead || 0;
  }

  /**
   * Raw network read on a position: prior over tiles plus a value in [-1,1].
   * `me` scores the position from a seat other than the one to move.
   */
  evaluate(state, legal, me) {
    const seat = me === undefined ? state.turn : me;
    const own = seat === state.turn;
    // Scoring from a seat that is not to move must let the encoder derive
    // plane 10 itself — that seat's own tiles, not the mover's legal moves.
    const moves = own ? (legal || legalMoves(state)) : null;
    const planes = encode(state, moves || undefined, undefined, seat);
    const t0 = Date.now();
    const { logits, value } = this.net.forward(planes, state.rows, state.cols);
    const dt = Date.now() - t0;
    this.msPerEval = this.msPerEval ? this.msPerEval * 0.8 + dt * 0.2 : dt;
    return { logits, value, moves };
  }

  /**
   * How to play this table.
   *
   * `search` — two seats, no teams: the game the network was trained on, and
   * the game its search assumes. Full Gumbel MCTS.
   *
   * `policy` — three or more seats: the *network* generalises to a
   * free-for-all perfectly well, but the search does not. Its backprop assumes
   * a point for me is a point against you, and against three opponents that is
   * false enough that adding simulations makes the same weights play steadily
   * *worse*. In a Rumble seat against three `hard` bots, over 112 games each:
   * 64% wins with no search at all, 49% at 8 simulations, 19% at 32, 16% at 96
   * — where the `hard` bot in that same seat wins 26% and chance is 25%. So a
   * wider table plays the raw prior, plus a check for a move that wins on the
   * spot. One evaluation per turn, and the strongest option measured.
   *
   * `none` — teams, or walls. In Duos a team-mate's tiles read as an enemy's in
   * the encoding, so the network is looking at the wrong board. Walls are a
   * subtler miss: the network never saw one in training, and measured at a
   * walled table it wins 21% where the `hard` bot it would replace wins 28%.
   * Both want their own training run; until then the alpha-beta search, which
   * understands them, keeps the seat.
   */
  modeFor(state) {
    if (state.teams || state.blocked) return 'none';
    return state.players.length === 2 ? 'search' : 'policy';
  }

  /** @returns {number|null} tile index to play, or null if there is nothing to do. */
  chooseMove(state, rnd = Math.random) {
    if (state.phase === PHASE_OVER) return null;
    const mode = this.modeFor(state);
    if (mode === 'none') return null;
    if (mode === 'policy') return this.chooseByPolicy(state);
    const rootMoves = legalMoves(state);
    if (!rootMoves.length) return null;
    if (rootMoves.length === 1) return rootMoves[0];

    const deadline = Date.now() + this.budgetMs;
    // Sequential halving spends its budget in phases, so the budget has to be
    // decided up front. Plan for what the clock will really buy here, keeping a
    // tenth back for the tree work between evaluations.
    const affordable = this.msPerEval
      ? Math.floor((this.budgetMs * 0.9) / this.msPerEval)
      : this.sims;
    const sims = Math.max(4, Math.min(this.sims, affordable));
    this.plannedSims = sims;

    const root = makeNode(state);
    // The root's own evaluation counts as a visit, exactly as it does at every
    // other node — otherwise the reported root value is an average over the
    // subtree only, and drifts from the reference implementation.
    this._backprop([root], this._expand(root, rootMoves), root.toPlay);

    const k = root.moves.length;
    const g = new Array(k);
    for (let i = 0; i < k; i++) g[i] = this.noise ? gumbel(rnd) : 0;
    this._g = g;

    let cands = Array.from({ length: k }, (_, i) => i)
      .sort((a, b) => (g[b] + root.logits[b]) - (g[a] + root.logits[a]))
      .slice(0, Math.min(this.mTop, k));

    let done = 0;
    let out = false;
    while (cands.length > 1 && done < sims && !out) {
      const phases = Math.max(1, Math.ceil(Math.log2(cands.length)));
      const target = Math.max(1, Math.floor((sims - done) / (phases * cands.length)));
      for (let round = 0; round < target && !out; round++) {
        for (const ci of cands) {
          this._simulate(root, ci);
          done++;
          if (done >= sims || Date.now() > deadline) { out = true; break; }
        }
      }
      // Halve only when the round quota was met with budget to spare. Running
      // out of simulations mid-round must leave the candidate set alone, or
      // the final pick is made from a set the search never finished judging.
      if (out) break;
      cands = cands
        .sort((a, b) => this._rootScore(root, b) - this._rootScore(root, a))
        .slice(0, Math.max(1, cands.length >> 1));
    }

    this.lastSims = done;
    this.lastValue = root.N ? root.W / root.N : 0;
    const visited = cands.filter((ci) => root.children[ci] && root.children[ci].N > 0);
    const pool = visited.length ? visited : cands;
    let best = pool[0];
    for (const ci of pool) {
      if (this._rootScore(root, ci) > this._rootScore(root, best)) best = ci;
    }
    return root.moves[best];
  }

  /**
   * Free-for-all play: the network's prior, with an outright win taken first.
   *
   * The win check is pure engine work — no extra evaluations — and it stops the
   * bot from walking past a move that ends the game in its favour, which a
   * prior trained on two-seat positions has no particular reason to rate
   * highest.
   */
  chooseByPolicy(state) {
    const moves = legalMoves(state);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];

    for (const m of moves) {
      const nxt = applyMoveFast(state, m);
      if (nxt.phase === PHASE_OVER && sameTeam(nxt, nxt.winner, state.turn)) return m;
    }

    const { logits, value } = this.evaluate(state, moves);
    this.lastValue = value;
    this.lastSims = 0;
    if (this.ffaLookahead > 0) return this._onePly(state, moves, logits);
    let best = moves[0];
    for (const m of moves) if (logits[m] > logits[best]) best = m;
    return best;
  }

  /**
   * One ply, scored from *my* seat rather than the mover's.
   *
   * The value head is perspective-relative and the encoding says nothing about
   * whose turn it is, so the position after each candidate can be scored from
   * my own point of view — a lookahead that never has to negate anything, which
   * is the step the two-seat search gets wrong at a wider table. Costs
   * `ffaLookahead` extra evaluations per turn.
   */
  _onePly(state, moves, logits) {
    const me = state.turn;
    const ranked = moves.slice().sort((a, b) => logits[b] - logits[a]);
    const cands = ranked.slice(0, Math.min(this.ffaLookahead, ranked.length));
    let best = cands[0];
    let bestV = -Infinity;
    for (const m of cands) {
      const nxt = applyMoveFast(state, m);
      let v;
      if (nxt.phase === PHASE_OVER) {
        v = sameTeam(nxt, nxt.winner, me) ? 1 : -1;
      } else if (!ownsAnything(nxt, me)) {
        v = -1;
      } else {
        v = this.evaluate(nxt, undefined, me).value;
      }
      if (v > bestV) { bestV = v; best = m; }
    }
    this.lastValue = bestV;
    return best;
  }

  /* --------------------------------------------------------------- search -- */

  _expand(node, legal) {
    const { logits, value, moves } = this.evaluate(node.state, legal);
    node.moves = moves;
    node.logits = moves.map((m) => logits[m]);
    node.children = new Array(moves.length).fill(null);
    node.expanded = true;
    return value;
  }

  _child(parent, ci) {
    let ch = parent.children[ci];
    if (!ch) {
      ch = makeNode(applyMoveFast(parent.state, parent.moves[ci]));
      parent.children[ci] = ch;
    }
    return ch;
  }

  _simulate(root, ci) {
    const path = [root];
    let node = this._child(root, ci);
    path.push(node);
    for (;;) {
      if (node.terminal) {
        this._backprop(path, node.termValue, node.toPlay);
        return;
      }
      if (!node.expanded) {
        const v = this._expand(node);
        this._backprop(path, v, node.toPlay);
        return;
      }
      node = this._child(node, this._select(node));
      path.push(node);
    }
  }

  _backprop(path, value, perspective) {
    for (const node of path) {
      node.N += 1;
      node.W += node.toPlay === perspective ? value : -value;
    }
  }

  _sigma(node) {
    let maxN = 0;
    for (const ch of node.children) if (ch && ch.N > maxN) maxN = ch.N;
    return (this.cVisit + maxN) * this.cScale;
  }

  _qFrom(parent, ci) {
    const ch = parent.children[ci];
    if (!ch || ch.N === 0) return null;
    const q = ch.W / ch.N;
    return ch.toPlay === parent.toPlay ? q : -q;
  }

  /** Non-root descent: argmax of the improved policy minus its visit share. */
  _select(node) {
    const sigma = this._sigma(node);
    const vNode = node.N ? node.W / node.N : 0;
    const scores = new Array(node.logits.length);
    const visits = new Array(node.logits.length);
    let total = 0;
    for (let ci = 0; ci < node.logits.length; ci++) {
      const q = this._qFrom(node, ci);
      scores[ci] = node.logits[ci] + sigma * (q === null ? vNode : q);
      visits[ci] = node.children[ci] ? node.children[ci].N : 0;
      total += visits[ci];
    }
    const pi = softmax(scores);
    const denom = 1 + total;
    let best = 0;
    let bestV = -Infinity;
    for (let ci = 0; ci < pi.length; ci++) {
      const v = pi[ci] - visits[ci] / denom;
      if (v > bestV) { bestV = v; best = ci; }
    }
    return best;
  }

  _rootScore(root, ci) {
    const q = this._qFrom(root, ci);
    if (q === null) return -Infinity;
    return this._g[ci] + root.logits[ci] + this._sigma(root) * q;
  }
}
