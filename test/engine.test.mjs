import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyMove, legalPlacements, legalMoves, neighbors, outDegree,
  scores, idxOf, EMPTY, MAX_BALLS, PHASE_PLACE, PHASE_PLAY, PHASE_OVER,
} from '../src/engine.js';

const P2 = [
  { name: 'A', kind: 'human' },
  { name: 'B', kind: 'human' },
];
const P4 = ['A', 'B', 'C', 'D'].map((name) => ({ name, kind: 'human' }));

function game(cols = 5, rows = 5, players = P2) {
  return createGame({ cols, rows, players });
}
/** Drive a game through moves, asserting each is legal. */
function play(s, ...moves) {
  for (const m of moves) {
    const r = applyMove(s, m);
    assert.ok(r.ok, `move ${m} should be legal for player ${s.turn}`);
    s = r.state;
  }
  return s;
}

test('board geometry', () => {
  const s = game();
  assert.deepEqual(neighbors(s, idxOf(s, 0, 0)), [1, 5]);          // corner: 2
  assert.deepEqual(neighbors(s, idxOf(s, 2, 0)), [1, 3, 7]);        // edge: 3
  assert.deepEqual(neighbors(s, idxOf(s, 2, 2)), [7, 11, 13, 17]);  // interior: 4
  assert.equal(outDegree(s, idxOf(s, 0, 0)), 2);
  assert.equal(outDegree(s, idxOf(s, 2, 2)), 4);
});

test('opening tile busts instantly and leaves its centre empty', () => {
  let s = game();
  const centre = idxOf(s, 1, 1); // interior (4 neighbours) and a legal opening
  assert.equal(outDegree(s, centre), 4);
  const r = applyMove(s, centre);
  assert.ok(r.ok);
  s = r.state;
  assert.equal(s.owner[centre], EMPTY, 'centre empties');
  assert.equal(s.count[centre], 0);
  for (const nb of neighbors(s, centre)) {
    assert.equal(s.owner[nb], 0, 'each neighbour claimed by opener');
    assert.equal(s.count[nb], 1, 'each neighbour gets exactly one ball');
  }
  assert.equal(scores(s).tiles[0], 4, 'interior opening yields 4 tiles');
});

test('opening in a corner loses balls off the board', () => {
  let s = game();
  s = play(s, idxOf(s, 0, 0));
  assert.equal(scores(s).tiles[0], 2, 'corner opening only yields 2 tiles');
  assert.equal(scores(s).balls[0], 2, 'the other 2 balls fall off the board');
});

test('opening masks may not overlap', () => {
  let s = game();
  s = play(s, idxOf(s, 1, 1));
  const legal = legalPlacements(s);
  // Everything within 2 tiles on both axes is blocked by player A's 3x3 mask.
  for (let y = 0; y <= 3; y++) {
    for (let x = 0; x <= 3; x++) {
      assert.ok(!legal.includes(idxOf(s, x, y)), `(${x},${y}) should be blocked`);
    }
  }
  assert.ok(legal.includes(idxOf(s, 4, 4)), 'far corner stays open');
  assert.ok(legal.includes(idxOf(s, 0, 4)), 'dy=3 clears the mask');
});

test('placement never strands a later player', () => {
  // 4 players on 5x5: the only non-overlapping arrangement is the four corners,
  // so the first player must be forced into a corner.
  const s = game(5, 5, P4);
  const legal = legalPlacements(s);
  for (const c of [idxOf(s, 0, 0), idxOf(s, 4, 0), idxOf(s, 0, 4), idxOf(s, 4, 4)]) {
    assert.ok(legal.includes(c), 'corners are always seatable');
  }
  // Central openings would leave nowhere for the other three, so they're barred.
  assert.ok(!legal.includes(idxOf(s, 2, 2)));
  assert.ok(!legal.includes(idxOf(s, 1, 2)));
  // Whatever the first player picks, the remaining three must still fit.
  for (const m of legal) {
    let t = applyMove(s, m).state;
    for (let k = 0; k < 3; k++) {
      const opts = legalPlacements(t);
      assert.ok(opts.length > 0, `stranded after opening at ${m}`);
      t = applyMove(t, opts[0]).state;
    }
  }
});

test('a centre opening is barred when it would strand the opponent', () => {
  // On 5x5 the 3x3 mask around the centre conflicts with every other tile.
  const s = game(5, 5, P2);
  assert.ok(!legalPlacements(s).includes(idxOf(s, 2, 2)));
  assert.equal(applyMove(s, idxOf(s, 2, 2)).ok, false);
  // With only one player there is nobody left to strand, so it opens up.
  const solo = game(5, 5, [{ name: 'A', kind: 'human' }]);
  assert.ok(legalPlacements(solo).includes(idxOf(solo, 2, 2)));
});

test('phase flips to play only once everyone has opened', () => {
  let s = game(7, 7, P4);
  assert.equal(s.phase, PHASE_PLACE);
  s = play(s, idxOf(s, 0, 0));
  assert.equal(s.phase, PHASE_PLACE);
  s = play(s, idxOf(s, 6, 0), idxOf(s, 0, 6));
  assert.equal(s.phase, PHASE_PLACE, 'still placing with one player to go');
  s = play(s, idxOf(s, 6, 6));
  assert.equal(s.phase, PHASE_PLAY);
  assert.equal(s.turn, 0, 'turn order wraps back to the first player');
});

test('clicking your own tile adds a ball up to 3', () => {
  let s = game();
  s = play(s, idxOf(s, 1, 1), idxOf(s, 4, 4));   // openings
  const t = idxOf(s, 1, 0);                       // A owns this, 1 ball
  assert.equal(s.owner[t], 0);
  assert.equal(s.count[t], 1);
  s = play(s, t);                                 // A -> 2
  assert.equal(s.count[t], 2);
  assert.equal(s.turn, 1, 'turn passes after a non-bust move');
  s = play(s, idxOf(s, 4, 3));                    // B filler
  s = play(s, t);                                 // A -> 3
  assert.equal(s.count[t], 3);
  assert.equal(s.owner[t], 0, 'tile is not yet bust at 3');
});

test('a 4th ball busts: tile empties, one ball to each neighbour', () => {
  let s = game();
  s = play(s, idxOf(s, 1, 1), idxOf(s, 4, 4));
  const t = idxOf(s, 2, 1); // A owns, 1 ball, interior
  assert.equal(outDegree(s, t), 4);
  s = play(s, t, idxOf(s, 4, 3));  // A->2
  s = play(s, t, idxOf(s, 4, 3));  // A->3
  assert.equal(s.count[t], 3);
  const before = scores(s).balls[0];
  const r = applyMove(s, t);       // A->bust
  s = r.state;
  assert.equal(s.owner[t], EMPTY, 'bust tile empties');
  assert.equal(s.count[t], 0);
  for (const nb of neighbors(s, t)) assert.equal(s.owner[nb], 0);
  assert.equal(scores(s).balls[0], before + 1, 'interior bust conserves: +1 placed, 4 out 4 in');
  assert.ok(r.frames.length >= 2, 'frames include the placement and one wave');
  assert.equal(r.frames[1].busts[0].at, t);
  assert.equal(r.frames[1].busts[0].to.length, 4);
});

test('busting captures enemy tiles', () => {
  // A at (1,1) opening, B at (4,4) opening. Build A up next to a B tile.
  let s = game();
  s = play(s, idxOf(s, 1, 1), idxOf(s, 3, 4));
  const bTile = idxOf(s, 3, 3);
  assert.equal(s.owner[bTile], 1, 'B owns (3,3)');
  const aTile = idxOf(s, 2, 3);
  // Hand-place a bust-ready A tile adjacent to B's.
  s.owner[aTile] = 0; s.count[aTile] = 3;
  s.turn = 0;
  const r = applyMove(s, aTile);
  assert.equal(r.state.owner[bTile], 0, 'B tile is captured by the cascade');
});

test('cascades chain through multiple waves', () => {
  let s = game();
  s = play(s, idxOf(s, 0, 0), idxOf(s, 4, 4));
  // A chain of loaded A tiles across the middle row.
  for (const x of [0, 1, 2, 3]) { const i = idxOf(s, x, 2); s.owner[i] = 0; s.count[i] = 3; }
  s.turn = 0;
  const r = applyMove(s, idxOf(s, 0, 2));
  assert.ok(r.frames.length > 2, 'multi-wave cascade produced several frames');
  const waveCount = r.frames.filter((f) => f.kind === 'wave').length;
  assert.ok(waveCount >= 2, `expected a chain reaction, got ${waveCount} wave(s)`);
});

test('two adjacent tiles bursting in one wave each keep a single ball', () => {
  let s = game();
  s = play(s, idxOf(s, 0, 0), idxOf(s, 4, 4));
  const a = idxOf(s, 1, 2);
  const b = idxOf(s, 2, 2);
  // Both loaded; bursting `a` pushes b to 4, and b's burst sends one back.
  s.owner[a] = 0; s.count[a] = 3;
  s.owner[b] = 0; s.count[b] = 3;
  s.turn = 0;
  const r = applyMove(s, a);
  // After the dust settles neither tile should hold more than capacity.
  for (let i = 0; i < r.state.count.length; i++) {
    assert.ok(r.state.count[i] <= MAX_BALLS, `tile ${i} over capacity: ${r.state.count[i]}`);
  }
});

test('no tile ever exceeds capacity after a move resolves', () => {
  // Random self-play fuzz: the invariant must hold at every step.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 40; trial++) {
    let s = game(6, 6, P4);
    for (let step = 0; step < 220 && s.phase !== PHASE_OVER; step++) {
      const moves = legalMoves(s);
      if (!moves.length) break;
      const r = applyMove(s, moves[Math.floor(rnd() * moves.length)]);
      assert.ok(r.ok);
      s = r.state;
      for (let i = 0; i < s.count.length; i++) {
        assert.ok(s.count[i] <= MAX_BALLS, `over capacity at trial ${trial} step ${step}`);
        assert.equal(s.count[i] === 0, s.owner[i] === EMPTY, 'owner and count must agree');
      }
    }
  }
});

test('eliminating every opponent ends the game', () => {
  let s = game();
  s = play(s, idxOf(s, 1, 1), idxOf(s, 4, 4));
  // Wipe B down to a single tile that A is about to take.
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === 1) { s.owner[i] = EMPTY; s.count[i] = 0; }
  const lone = idxOf(s, 3, 3);
  s.owner[lone] = 1; s.count[lone] = 1;
  const attacker = idxOf(s, 2, 3);
  s.owner[attacker] = 0; s.count[attacker] = 3;
  s.turn = 0;
  const r = applyMove(s, attacker);
  assert.equal(r.state.phase, PHASE_OVER);
  assert.equal(r.state.winner, 0);
  assert.equal(r.state.players[1].alive, false);
});

test('eliminated players are skipped in turn order', () => {
  let s = game(7, 7, P4);
  s = play(s, idxOf(s, 0, 0), idxOf(s, 6, 0), idxOf(s, 0, 6), idxOf(s, 6, 6));
  s.players[1].alive = false;
  s.turn = 0;
  const r = applyMove(s, legalMoves(s)[0]);
  assert.equal(r.state.turn, 2, 'turn skips the eliminated player');
});

test('illegal moves are rejected without mutating state', () => {
  let s = game();
  s = play(s, idxOf(s, 1, 1), idxOf(s, 4, 4));
  const enemy = idxOf(s, 4, 3);
  assert.equal(s.owner[enemy], 1);
  const r = applyMove(s, enemy); // A cannot click B's tile
  assert.equal(r.ok, false);
  assert.equal(r.state, s, 'state is returned untouched');
  assert.equal(applyMove(s, -1).ok, false);
  assert.equal(applyMove(s, 999).ok, false);
  const empty = idxOf(s, 2, 2);
  assert.equal(s.owner[empty], EMPTY);
  assert.equal(applyMove(s, empty).ok, false, 'cannot click a neutral tile in play phase');
});

test('applyMove does not mutate the previous state', () => {
  let s = game();
  s = play(s, idxOf(s, 1, 1), idxOf(s, 4, 4));
  const ownerBefore = s.owner.slice();
  const countBefore = s.count.slice();
  const turnBefore = s.turn;
  applyMove(s, idxOf(s, 1, 0));
  assert.deepEqual(s.owner, ownerBefore);
  assert.deepEqual(s.count, countBefore);
  assert.equal(s.turn, turnBefore);
});
