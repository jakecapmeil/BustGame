/**
 * Trophy-ladder maths. Pure functions, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANKS, rankFor, nextRank, progressToNext, floorFor,
  matchmake, matchmakeSeeded, placements, scoreResult, applyDelta, recordMatch,
} from '../src/rank.js';

/** A finished-game stub good enough for the scorer. */
function overState({ cols = 6, rows = 6, players = 2, winner = 0, turnNumber = 30, myTiles = 20 }) {
  const owner = new Int8Array(cols * rows).fill(-1);
  for (let i = 0; i < myTiles; i++) owner[i] = winner;
  return {
    cols, rows, owner, count: new Uint8Array(cols * rows),
    players: Array.from({ length: players }, (_, i) => ({ id: i, alive: i === winner })),
    winner, turnNumber, phase: 'over',
  };
}

test('rank thresholds are strictly increasing and start at zero', () => {
  assert.equal(RANKS[0].min, 0);
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i].min > RANKS[i - 1].min);
});

test('rankFor / nextRank / progress track the trophy count', () => {
  assert.equal(rankFor(0).key, 'wood');
  assert.equal(rankFor(119).key, 'wood');
  assert.equal(rankFor(120).key, 'stone');
  assert.equal(nextRank(0).key, 'stone');
  assert.equal(nextRank(RANKS[RANKS.length - 1].min), null);
  const p = progressToNext(60); // halfway from wood(0) to stone(120)
  assert.equal(p.frac, 0.5);
});

test('matchmake fills every seat with rank-appropriate bots', () => {
  const m = matchmake(0, 2, () => 0.5);
  assert.equal(m.players.length, 2, 'one bot for a two-seat mode');
  assert.equal(m.players[0].kind, 'human');
  assert.equal(m.players[1].kind, 'ai');
  assert.equal(m.players[1].difficulty, 'easy', 'Woodline draws from the easy pool');
  assert.equal(m.ratings[0], 0, 'my rating is my trophy count');

  const gold = matchmake(1200, 4, () => 0.5);
  assert.equal(gold.players.length, 4, 'a four-seat mode fields three bots');
  assert.ok(['hard', 'expert'].includes(gold.players[1].difficulty));

  const mayhem = matchmake(1200, 8, () => 0.5);
  assert.equal(mayhem.players.length, 8, 'eight seats, seven bots');
  assert.equal(mayhem.ratings.length, 8);
});

test('matchmakeSeeded is deterministic', () => {
  const a = matchmakeSeeded(800, 4, 7);
  const b = matchmakeSeeded(800, 4, 7);
  assert.deepEqual(a.ratings, b.ratings);
  assert.deepEqual(a.players.map((p) => p.difficulty), b.players.map((p) => p.difficulty));
});

test('placements: winner first, then by how long each lasted', () => {
  const s = overState({ players: 4, winner: 2 });
  const elimTurn = { 0: 5, 1: 22, 3: 14 }; // p0 out earliest, p1 lasted longest
  const place = placements(s, elimTurn);
  assert.equal(place[2], 1);
  assert.equal(place[1], 2);
  assert.equal(place[3], 3);
  assert.equal(place[0], 4);
});

test('an even-rated win scores near the base K, a loss the negative of it', () => {
  const s = overState({ winner: 0, turnNumber: 40, myTiles: 18 });
  const win = scoreResult({ state: s, myId: 0, ratings: [800, 800], elimTurn: { 1: 40 }, trophies: 800, played: 50 });
  assert.ok(win.delta > 0 && win.delta <= 45);
  assert.ok(win.delta >= 18 && win.delta <= 34, `even win ~base, got ${win.delta}`);

  const sl = overState({ winner: 1, turnNumber: 40, myTiles: 0 });
  const loss = scoreResult({ state: sl, myId: 0, ratings: [800, 800], elimTurn: { 0: 30 }, trophies: 800, played: 50 });
  assert.ok(loss.delta < 0);
});

test('beating a stronger opponent pays more than beating a weaker one', () => {
  const s = overState({ winner: 0, turnNumber: 40, myTiles: 18 });
  const vsStrong = scoreResult({ state: s, myId: 0, ratings: [800, 1200], elimTurn: { 1: 40 }, trophies: 800, played: 50 });
  const vsWeak = scoreResult({ state: s, myId: 0, ratings: [800, 400], elimTurn: { 1: 40 }, trophies: 800, played: 50 });
  assert.ok(vsStrong.delta > vsWeak.delta, `${vsStrong.delta} !> ${vsWeak.delta}`);
});

test('losing badly costs more than losing narrowly', () => {
  // Narrow: eliminated late, second of two.
  const sNarrow = overState({ winner: 1, turnNumber: 50, myTiles: 0 });
  const narrow = scoreResult({ state: sNarrow, myId: 0, ratings: [800, 800], elimTurn: { 0: 47 }, trophies: 800, played: 50 });
  // Blowout: wiped out early.
  const sBlow = overState({ winner: 1, turnNumber: 50, myTiles: 0 });
  const blow = scoreResult({ state: sBlow, myId: 0, ratings: [800, 800], elimTurn: { 0: 6 }, trophies: 800, played: 50 });
  assert.ok(blow.delta < narrow.delta, `blowout ${blow.delta} should be worse than narrow ${narrow.delta}`);
});

test('crushing a win pays more than scraping one', () => {
  const crush = scoreResult({
    state: overState({ winner: 0, turnNumber: 14, myTiles: 34 }), myId: 0,
    ratings: [800, 800], elimTurn: { 1: 14 }, trophies: 800, played: 50,
  });
  const scrape = scoreResult({
    state: overState({ winner: 0, turnNumber: 80, myTiles: 8 }), myId: 0,
    ratings: [800, 800], elimTurn: { 1: 80 }, trophies: 800, played: 50,
  });
  assert.ok(crush.delta > scrape.delta, `${crush.delta} !> ${scrape.delta}`);
});

test('placement games (played < 10) swing harder', () => {
  const s = overState({ winner: 0, turnNumber: 40, myTiles: 18 });
  const early = scoreResult({ state: s, myId: 0, ratings: [200, 200], elimTurn: { 1: 40 }, trophies: 200, played: 2 });
  const settled = scoreResult({ state: s, myId: 0, ratings: [200, 200], elimTurn: { 1: 40 }, trophies: 200, played: 80 });
  assert.ok(early.delta > settled.delta);
});

test('applyDelta clamps at zero and respects the rank floor on a loss', () => {
  assert.equal(applyDelta(10, -50), 0);
  // In Bronze (min 300): floor is 300 - 60 = 240, so a loss can't fall through it.
  assert.equal(applyDelta(310, -100), 240);
  // A win is never floored.
  assert.equal(applyDelta(310, 40), 350);
});

test('recordMatch folds the result into the profile and flags promotion', () => {
  const p0 = { trophies: 110, best: 110, played: 4, won: 2, streak: 1 };
  const up = recordMatch(p0, { delta: 30, win: true });
  assert.equal(up.profile.trophies, 140);
  assert.equal(up.profile.best, 140);
  assert.equal(up.profile.played, 5);
  assert.equal(up.profile.won, 3);
  assert.equal(up.profile.streak, 2);
  assert.equal(up.promotedTo.key, 'stone', 'crossed 120 into Stoneworks');

  const flat = recordMatch(up.profile, { delta: -10, win: false });
  assert.equal(flat.promotedTo, null);
  assert.equal(flat.profile.streak, -1, 'a loss resets a win streak to -1');
});

/* ------------------------------------------------------------- team scoring -- */

/** A finished 2v2 where `winner` names one member of the winning side. */
function overTeamState({ winner = 0, turnNumber = 40, teamTiles = 24 }) {
  const cols = 8, rows = 8;
  const owner = new Int8Array(cols * rows).fill(-1);
  const teams = [0, 1, 0, 1];
  const mate = teams.findIndex((t, i) => t === teams[winner] && i !== winner);
  for (let i = 0; i < teamTiles; i++) owner[i] = i % 2 ? winner : mate;
  return {
    cols, rows, owner, count: new Uint8Array(cols * rows), teams, blocked: null,
    players: Array.from({ length: 4 }, (_, i) => ({ id: i, alive: teams[i] === teams[winner] })),
    winner, turnNumber, phase: 'over',
  };
}

test('both partners share first place', () => {
  const s = overTeamState({ winner: 0 });
  const place = placements(s, { 1: 30, 3: 36 });
  assert.equal(place[0], 1);
  assert.equal(place[2], 1, 'the partner ties for first, not second');
  assert.ok(place[1] > 1 && place[3] > 1);
});

test("a partner's win counts as your win, and team-mates are not opponents", () => {
  // Player 2 wins; player 0 is their partner and was knocked out early.
  const s = overTeamState({ winner: 2 });
  const r = scoreResult({
    state: s, myId: 0, ratings: [800, 800, 800, 800],
    elimTurn: { 0: 12, 1: 38, 3: 40 }, trophies: 800, played: 50,
  });
  assert.equal(r.win, true, 'carried by a partner still counts as a win');
  assert.ok(r.delta > 0);
  assert.equal(r.breakdown.length, 2, 'only the two opponents are scored against');
  assert.ok(r.breakdown.every((b) => b.oppId === 1 || b.oppId === 3));
});

test('walls are excluded from the dominance measure', () => {
  const base = overState({ winner: 0, turnNumber: 40, myTiles: 18 });
  const walled = overState({ winner: 0, turnNumber: 40, myTiles: 18 });
  // Half the board is wall, so holding 18 tiles is far more dominant.
  walled.blocked = new Uint8Array(walled.cols * walled.rows);
  for (let i = 18; i < walled.blocked.length; i++) walled.blocked[i] = 1;
  const a = scoreResult({ state: base, myId: 0, ratings: [800, 800], elimTurn: { 1: 40 }, trophies: 800, played: 50 });
  const b = scoreResult({ state: walled, myId: 0, ratings: [800, 800], elimTurn: { 1: 40 }, trophies: 800, played: 50 });
  assert.ok(b.marginScore > a.marginScore, 'a wall is not ground you failed to take');
});
