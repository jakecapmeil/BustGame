/**
 * The neural opponent's brain, checked against the model it was exported from.
 *
 * `bustai/export_weights.py` records, for a set of real positions, the input
 * planes and the network's outputs as computed by PyTorch at the precision
 * that actually ships. These tests replay those positions through the game's
 * own engine, encode them here, and demand the JS forward pass agrees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGame, applyMove, legalMoves } from '../src/engine.js';
import { NeuralBot } from '../src/nn-bot.js';
import { BustNet, encode, N_PLANES } from '../src/nn.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NET_DIR = path.join(HERE, '..', 'assets', 'net');
const FIXTURE = path.join(HERE, 'fixtures', 'nn_reference.json');

const have = fs.existsSync(path.join(NET_DIR, 'bust_net.bin')) && fs.existsSync(FIXTURE);

function loadNet() {
  const meta = JSON.parse(fs.readFileSync(path.join(NET_DIR, 'bust_net.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(NET_DIR, 'bust_net.bin'));
  return new BustNet(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function replay(ref, moves) {
  const players = Array.from({ length: ref.seats }, (_, i) => ({ name: `P${i}`, kind: 'ai' }));
  let s = createGame({ cols: ref.cols, rows: ref.rows, players });
  for (const m of moves) {
    const r = applyMove(s, m);
    assert.ok(r.ok, `reference move ${m} was rejected`);
    s = r.state;
  }
  return s;
}

test('the encoder matches the one the net was trained with', { skip: !have }, () => {
  const ref = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const c of ref.cases) {
    const s = replay(ref, c.moves);
    const planes = encode(s, legalMoves(s));
    assert.equal(planes.length, N_PLANES * ref.cols * ref.rows);
    for (let i = 0; i < planes.length; i++) {
      // Python stores planes as value*4 in a byte — exactly representable.
      assert.equal(planes[i], c.planes[i] / 4, `plane value ${i} differs`);
    }
  }
});

test('the forward pass matches PyTorch', { skip: !have }, () => {
  const ref = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const net = loadNet();
  let worstLogit = 0;
  let worstValue = 0;
  for (const c of ref.cases) {
    const s = replay(ref, c.moves);
    const { logits, value } = net.forward(encode(s, legalMoves(s)), ref.rows, ref.cols);
    let bestJs = 0;
    let bestPy = 0;
    for (let i = 0; i < logits.length; i++) {
      worstLogit = Math.max(worstLogit, Math.abs(logits[i] - c.logits[i]));
      if (logits[i] > logits[bestJs]) bestJs = i;
      if (c.logits[i] > c.logits[bestPy]) bestPy = i;
    }
    worstValue = Math.max(worstValue, Math.abs(value - c.value));
    assert.equal(bestJs, bestPy, 'the two ports pick the same best move');
  }
  assert.ok(worstLogit < 2e-3, `logits drifted by ${worstLogit}`);
  assert.ok(worstValue < 2e-4, `value drifted by ${worstValue}`);
});

test('the net runs on a board size it was never trained on', { skip: !have }, () => {
  // Fully convolutional, so a 7x7 net has to work on Rumble's 8x8 as well.
  const net = loadNet();
  const players = [{ name: 'A', kind: 'ai' }, { name: 'B', kind: 'ai' }];
  let s = createGame({ cols: 8, rows: 8, players });
  s = applyMove(s, 9).state;
  s = applyMove(s, 54).state;
  const { logits, value } = net.forward(encode(s, legalMoves(s)), 8, 8);
  assert.equal(logits.length, 64);
  assert.ok(Number.isFinite(value) && value >= -1 && value <= 1);
  for (const v of logits) assert.ok(Number.isFinite(v));
});

test('the JS search reproduces the Python search move for move', { skip: !have }, () => {
  // Same weights, same budget, no Gumbel noise on either side: the two ports
  // of Gumbel AlphaZero should reach the same decision, not merely a similar one.
  const SEARCH = path.join(HERE, 'fixtures', 'nn_search_reference.json');
  if (!fs.existsSync(SEARCH)) return;
  const ref = JSON.parse(fs.readFileSync(SEARCH, 'utf8'));
  const net = loadNet();
  let agree = 0;
  let worstValue = 0;
  for (const c of ref.cases) {
    const s = replay(ref, c.moves);
    const bot = new NeuralBot(net, {
      sims: ref.sims, mTop: ref.m_top, budgetMs: 1e9, noise: false,
    });
    const move = bot.chooseMove(s);
    assert.ok(legalMoves(s).includes(move), 'the search returns a legal move');
    if (move === c.chosen) agree++;
    worstValue = Math.max(worstValue, Math.abs(bot.lastValue - c.root_value));
  }
  assert.equal(agree, ref.cases.length,
    `search agreed on ${agree}/${ref.cases.length} positions`);
  // Not bit-exact: torch and this port accumulate a convolution in different
  // orders, so a near-tie deep in the tree can occasionally fall the other way.
  // The decision is what has to match; the value only has to be close.
  assert.ok(worstValue < 5e-3, `root value drifted by ${worstValue}`);
});

test('the bot never returns an illegal move over a whole game', { skip: !have }, () => {
  const net = loadNet();
  const bot = new NeuralBot(net, { sims: 8, mTop: 6, budgetMs: 1e9 });
  const players = [{ name: 'A', kind: 'ai' }, { name: 'B', kind: 'ai' }];
  let s = createGame({ cols: 7, rows: 7, players });
  for (let ply = 0; ply < 120 && s.phase !== 'over'; ply++) {
    const m = bot.chooseMove(s, () => 0.5);
    assert.ok(legalMoves(s).includes(m), `ply ${ply}: ${m} is not legal`);
    const r = applyMove(s, m);
    assert.ok(r.ok);
    s = r.state;
  }
});

test('the search plans for the clock it actually has', { skip: !have }, () => {
  // A slow device must get a shallower search, not an overrunning one. The bot
  // measures what an evaluation costs here and plans the schedule for that.
  const net = loadNet();
  const players = [{ name: 'A', kind: 'ai' }, { name: 'B', kind: 'ai' }];
  let s = createGame({ cols: 7, rows: 7, players });
  s = applyMove(s, 8).state;
  s = applyMove(s, 40).state;

  const generous = new NeuralBot(net, { sims: 64, mTop: 12, budgetMs: 60000 });
  generous.chooseMove(s, () => 0.5);          // first move measures the cost
  generous.chooseMove(s, () => 0.5);
  assert.equal(generous.plannedSims, 64, 'with time to spare it plans the full budget');
  assert.ok(generous.msPerEval > 0, 'it measured what an evaluation costs');

  const rushed = new NeuralBot(net, { sims: 64, mTop: 12, budgetMs: 1 });
  rushed.chooseMove(s, () => 0.5);
  const t0 = Date.now();
  const move = rushed.chooseMove(s, () => 0.5);
  const elapsed = Date.now() - t0;
  assert.ok(rushed.plannedSims < 64, `a 1 ms budget planned ${rushed.plannedSims} sims`);
  assert.ok(legalMoves(s).includes(move), 'and still returns a legal move');
  assert.ok(elapsed < 2000, `an impossible budget still returned promptly (${elapsed} ms)`);
});

test('a free-for-all plays the prior, not the two-seat search', { skip: !have }, () => {
  // The search assumes a point for me is a point against you. With three
  // opponents that is false, and measurably so — see ../bustai/diagnose_ffa.py.
  // A wider table must therefore take the policy path: one evaluation, no tree.
  const net = loadNet();
  const bot = new NeuralBot(net, { sims: 96, mTop: 12, budgetMs: 60000 });
  const players = Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, kind: 'ai' }));
  let s = createGame({ cols: 8, rows: 8, players });
  for (let k = 0; k < 4; k++) s = applyMove(s, legalMoves(s)[0]).state;

  assert.equal(bot.modeFor(s), 'policy');
  const t0 = Date.now();
  const m = bot.chooseMove(s, () => 0.5);
  const elapsed = Date.now() - t0;
  assert.ok(legalMoves(s).includes(m), 'the policy path returns a legal move');
  assert.equal(bot.lastSims, 0, 'and runs no simulations');
  assert.ok(elapsed < 1500, `one evaluation should be quick (${elapsed} ms)`);

  const duel = createGame({ cols: 7, rows: 7, players: players.slice(0, 2) });
  assert.equal(bot.modeFor(duel), 'search', 'two seats still get the full search');
});

test('the policy path takes a win on the spot', { skip: !have }, () => {
  const net = loadNet();
  const bot = new NeuralBot(net, { sims: 96, mTop: 12, budgetMs: 60000 });
  const players = Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, kind: 'ai' }));
  let s = createGame({ cols: 8, rows: 8, players });
  for (let k = 0; k < 4; k++) s = applyMove(s, legalMoves(s)[0]).state;

  // Leave seat 0 holding the board and seat 1 holding one tile inside the blast
  // radius of a loaded seat-0 tile; seats 2 and 3 are already out.
  for (let i = 0; i < s.owner.length; i++) { s.owner[i] = -1; s.count[i] = 0; }
  s.players[2].alive = false;
  s.players[3].alive = false;
  const at = (x, y) => y * s.cols + x;
  s.owner[at(2, 3)] = 0; s.count[at(2, 3)] = 3;   // the loaded attacker
  s.owner[at(6, 6)] = 0; s.count[at(6, 6)] = 1;   // a spare tile, so it has a choice
  s.owner[at(3, 3)] = 1; s.count[at(3, 3)] = 1;   // seat 1's last tile
  s.turn = 0;

  const m = bot.chooseMove(s, () => 0.5);
  assert.equal(m, at(2, 3), 'it busts to win rather than following the prior');
  const after = applyMove(s, m).state;
  assert.equal(after.phase, 'over');
  assert.equal(after.winner, 0);
});

test('team games fall back rather than misread the board', { skip: !have }, () => {
  // In Duos a team-mate's tiles land in the opponent planes, so the network is
  // looking at a board that is not the one being played.
  const net = loadNet();
  const bot = new NeuralBot(net, { sims: 96, mTop: 12, budgetMs: 60000 });
  const players = ['A1', 'B1', 'A2', 'B2'].map((name) => ({ name, kind: 'ai' }));
  let s = createGame({ cols: 10, rows: 10, players, teams: [0, 1, 0, 1] });
  for (let k = 0; k < 4; k++) s = applyMove(s, legalMoves(s)[0]).state;
  assert.equal(bot.modeFor(s), 'none');
  assert.equal(bot.chooseMove(s, () => 0.5), null);
});

test('the one-ply free-for-all lookahead matches the Python reference',
  { skip: !have }, () => {
  // The wider modes do not use the search, so they get their own parity check:
  // same weights, same candidate ordering, same own-perspective scoring.
  const FFA = path.join(HERE, 'fixtures', 'nn_ffa_reference.json');
  if (!fs.existsSync(FFA)) return;
  const ref = JSON.parse(fs.readFileSync(FFA, 'utf8'));
  const net = loadNet();
  const bot = new NeuralBot(net, { ffaLookahead: ref.top_k, budgetMs: 1e9 });
  let agree = 0;
  for (const c of ref.cases) {
    const s = replay(ref, c.moves);
    assert.equal(bot.modeFor(s), 'policy');
    const m = bot.chooseMove(s, () => 0.5);
    assert.ok(legalMoves(s).includes(m), 'the one-ply path returns a legal move');
    if (m === c.chosen) agree++;
  }
  assert.equal(agree, ref.cases.length,
    `one-ply agreed on ${agree}/${ref.cases.length} positions`);
});

test('the encoder can score a position from a seat that is not to move',
  { skip: !have }, () => {
  // This is what makes the one-ply lookahead possible: nothing in the encoding
  // says whose turn it is, so any seat can ask "how good is this for me".
  const players = Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, kind: 'ai' }));
  let s = createGame({ cols: 8, rows: 8, players });
  for (let k = 0; k < 4; k++) s = applyMove(s, legalMoves(s)[0]).state;
  const n = s.owner.length;
  const mine = encode(s, undefined, undefined, s.turn);
  const theirs = encode(s, undefined, undefined, 1);
  assert.notDeepEqual(Array.from(mine), Array.from(theirs), 'the two views differ');
  // plane 10 from seat 1's view is exactly seat 1's tiles
  const mask = [];
  for (let i = 0; i < n; i++) if (theirs[10 * n + i] === 1) mask.push(i);
  const owned = [];
  for (let i = 0; i < n; i++) if (s.owner[i] === 1) owned.push(i);
  assert.deepEqual(mask, owned);
});

test('walled boards fall back too', { skip: !have }, () => {
  // The network never saw a wall in training and measures worse than the bot it
  // would replace at a walled table, so it declines the seat.
  const net = loadNet();
  const bot = new NeuralBot(net, { budgetMs: 60000 });
  const players = Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, kind: 'ai' }));
  const blocked = new Uint8Array(64);
  for (const i of [18, 21, 42, 45]) blocked[i] = 1;
  let s = createGame({ cols: 8, rows: 8, players, blocked });
  for (let k = 0; k < 4; k++) s = applyMove(s, legalMoves(s)[0]).state;
  assert.equal(bot.modeFor(s), 'none');
  assert.equal(bot.chooseMove(s, () => 0.5), null);

  // ...and an open board of the same shape does not.
  let open = createGame({ cols: 8, rows: 8, players });
  for (let k = 0; k < 4; k++) open = applyMove(open, legalMoves(open)[0]).state;
  assert.equal(bot.modeFor(open), 'policy');
});
