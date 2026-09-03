/**
 * BUST — trophy ladder.
 *
 * A Clash-Royale-style progression for solo play: a match against matchmade
 * bots moves your trophy count up on a win and down on a loss, by an amount
 * that scales with how strong the opponents were (Elo) and how one-sided the
 * result was (margin / "how badly you lost"). Crossing a trophy threshold
 * promotes you to the next rank, where the bots are tougher.
 *
 * Everything here is a pure function of its inputs except `loadProfile` /
 * `saveProfile`, which are thin `localStorage` wrappers. No DOM, no engine
 * imports — the caller hands in the finished game state.
 */

/* ------------------------------------------------------------------ ranks -- */

/**
 * The ladder. A rank sets only *how strong* your opponents are — the shape of
 * the match (seats, board, teams, walls) belongs to the selected mode, so you
 * climb the same ladder whichever mode you prefer to play.
 *
 * The ranks are a yield ladder: ten real classes of explosive, each one an
 * order of magnitude past the last, from a two-gram firecracker to the 50 Mt
 * Tsar Bomba. `key` doubles as the icon name in `icons.js` and as the tint key
 * in the app's RANK_COLORS, so a rank is named once and picked up everywhere.
 */
export const RANKS = [
  { key: 'firecracker', name: 'Firecracker', min: 0,    pool: ['easy'] },
  { key: 'dynamite',    name: 'Dynamite',    min: 120,  pool: ['easy', 'medium'] },
  { key: 'grenade',     name: 'Grenade',     min: 300,  pool: ['medium'] },
  { key: 'shell',       name: 'Shell',       min: 520,  pool: ['medium', 'hard'] },
  { key: 'bombshell',   name: 'Bombshell',   min: 800,  pool: ['hard'] },
  { key: 'airstrike',   name: 'Airstrike',   min: 1150, pool: ['hard', 'expert'] },
  { key: 'moab',        name: 'MOAB',        min: 1550, pool: ['expert'] },
  { key: 'fatman',      name: 'Fat Man',     min: 2000, pool: ['expert', 'brutal'] },
  { key: 'hydrogen',    name: 'Hydrogen',    min: 2600, pool: ['brutal'] },
  { key: 'tsar',        name: 'Tsar Bomba',  min: 3300, pool: ['brutal'] },
];

export function rankIndexFor(trophies) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (trophies >= RANKS[i].min) idx = i;
  return idx;
}

export function rankFor(trophies) {
  return RANKS[rankIndexFor(trophies)];
}

export function nextRank(trophies) {
  const i = rankIndexFor(trophies);
  return i + 1 < RANKS.length ? RANKS[i + 1] : null;
}

/** Progress within the current rank band: { have, need, frac (0..1) }. */
export function progressToNext(trophies) {
  const cur = rankFor(trophies);
  const nxt = nextRank(trophies);
  if (!nxt) return { have: trophies - cur.min, need: 0, frac: 1 };
  const span = nxt.min - cur.min;
  const have = trophies - cur.min;
  return { have, need: span, frac: Math.max(0, Math.min(1, have / span)) };
}

/**
 * You can slip one band below a rank you've reached, but a bad run can't wipe a
 * whole rank in one go (a gentler version of Clash Royale's trophy gates).
 */
export function floorFor(trophies) {
  const cur = rankFor(trophies);
  return Math.max(0, cur.min - 60);
}

/* --------------------------------------------------------------- matchmake -- */

const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Field the bots for a ranked match. The mode has already decided how many
 * seats there are; the rank decides how hard each bot plays and what rating it
 * carries into the Elo maths.
 *
 * @param {number} trophies
 * @param {number} seats   total players including the human
 * @param {() => number} [rnd]
 * @returns {{ rankKey:string, players:Array<{name,kind,difficulty}>, ratings:number[] }}
 *          `players[0]` / `ratings[0]` are the human.
 */
export function matchmake(trophies, seats, rnd = Math.random) {
  const rank = rankFor(trophies);
  const botCount = Math.max(1, seats - 1);

  const players = [{ name: 'You', kind: 'human', difficulty: 'medium' }];
  const ratings = [trophies];

  for (let i = 0; i < botCount; i++) {
    const difficulty = rank.pool[Math.floor(rnd() * rank.pool.length) % rank.pool.length];
    // Opponents rated within a Clash-Royale-ish window of the player.
    const spread = 90 + rnd() * 120;
    const rating = Math.max(0, Math.round(trophies + (rnd() - 0.45) * 2 * spread));
    players.push({
      name: botCount === 1 ? 'Rival' : `Rival ${i + 1}`,
      kind: 'ai',
      difficulty,
    });
    ratings.push(rating);
  }
  return { rankKey: rank.key, players, ratings };
}

/** Deterministic matchmaking for a given match number — keeps tests stable. */
export function matchmakeSeeded(trophies, seats, matchNo) {
  return matchmake(trophies, seats, mulberry32((trophies | 0) * 2654435761 + matchNo));
}

/* ----------------------------------------------------------------- scoring -- */

const expectedScore = (mine, theirs) => 1 / (1 + 10 ** ((theirs - mine) / 400));

function kFactor(trophies, played) {
  if (played < 10) return 60;      // placement games move fast
  if (trophies >= RANKS[8].min) return 28; // Hydrogen and above
  return 40;
}

/** Which side a player is on. Mirrors engine.teamOf without importing it. */
function teamOf(state, pid) {
  return state.teams ? state.teams[pid] : pid;
}

/** Everyone sharing the winner's side — the whole team in a Duos match. */
function winnerSet(state) {
  if (state.winner === null || state.winner === undefined) return new Set();
  const t = teamOf(state, state.winner);
  return new Set(state.players.filter((p) => teamOf(state, p.id) === t).map((p) => p.id));
}

/**
 * Finishing order, best first. `placement[pid]` = 1 (winner) .. n (first out).
 * Every member of the winning side shares first place; losers are ranked by how
 * long they lasted (`elimTurn`, higher = later).
 */
export function placements(state, elimTurn) {
  const n = state.players.length;
  const won = winnerSet(state);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(i);
  ids.sort((a, b) => {
    const wa = won.has(a) ? 1 : 0;
    const wb = won.has(b) ? 1 : 0;
    if (wa !== wb) return wb - wa;
    return (elimTurn[b] || 0) - (elimTurn[a] || 0); // lasted longer => better
  });
  const place = new Array(n).fill(n);
  let rank = 0;
  ids.forEach((pid, i) => {
    // Team-mates who won together tie for first rather than 1st and 2nd.
    if (i > 0 && won.has(pid) && won.has(ids[i - 1])) { place[pid] = place[ids[i - 1]]; return; }
    rank = i + 1;
    place[pid] = rank;
  });
  return place;
}

/**
 * Trophy delta for the human after a ranked match.
 *
 * @param {object} o
 * @param {object} o.state       finished game state (state.phase === 'over')
 * @param {number} o.myId        the human's player id
 * @param {number[]} o.ratings   rating per player id (o.ratings[o.myId] = my trophies)
 * @param {number[]} o.elimTurn  turnNumber each player was eliminated on (0 if never)
 * @param {number} o.trophies    my current trophy count
 * @param {number} o.played      ranked matches I've completed
 * @returns {{ delta:number, win:boolean, placement:number, players:number,
 *             marginScore:number, badness:number,
 *             breakdown:Array<{oppId:number, oppRating:number, expected:number, result:number}> }}
 */
export function scoreResult({ state, myId, ratings, elimTurn, trophies, played }) {
  const n = state.players.length;
  const place = placements(state, elimTurn);
  const myPlace = place[myId];
  const win = winnerSet(state).has(myId);   // a partner's win is your win
  const myRating = ratings[myId];
  const myTeam = teamOf(state, myId);

  // Elo, averaged over every opponent as an implicit 1v1 (placed above => 1).
  // Team-mates are not opponents, so they never enter the maths.
  const breakdown = [];
  let sum = 0;
  for (let pid = 0; pid < n; pid++) {
    if (pid === myId || teamOf(state, pid) === myTeam) continue;
    const result = myPlace < place[pid] ? 1 : myPlace > place[pid] ? 0 : 0.5;
    const expected = expectedScore(myRating, ratings[pid]);
    breakdown.push({ oppId: pid, oppRating: ratings[pid], expected, result });
    sum += result - expected;
  }
  if (!breakdown.length) {
    return { delta: 0, win, placement: myPlace, players: n, marginScore: 0, badness: 0, breakdown };
  }
  const raw = kFactor(trophies, played) * (sum / breakdown.length);

  // How one-sided was it? Walls don't count as ground you could have held, and
  // in a team game your partner's territory is your territory.
  let boardTiles = 0;
  for (let i = 0; i < state.owner.length; i++) if (!state.blocked || !state.blocked[i]) boardTiles++;
  boardTiles = Math.max(1, boardTiles);
  const finalTurn = Math.max(1, state.turnNumber);
  let myTiles = 0;
  for (let i = 0; i < state.owner.length; i++) {
    const o = state.owner[i];
    if (o !== -1 && teamOf(state, o) === myTeam) myTiles++;
  }

  let marginScore = 0;
  let badness = 0;
  if (win) {
    const dominance = myTiles / boardTiles;                       // ~0.3 .. 1
    const par = boardTiles * 1.4;
    const speed = Math.max(0, (par - finalTurn) / par);           // finished quick?
    marginScore = Math.max(0, Math.min(1, 0.65 * dominance + 0.9 * speed));
  } else {
    const placeFrac = n > 1 ? (myPlace - 1) / (n - 1) : 1;        // last place => 1
    const myElim = elimTurn[myId] || finalTurn;
    const early = Math.max(0, Math.min(1, 1 - myElim / finalTurn)); // out early => ~1
    badness = Math.max(0, Math.min(1, 0.55 * placeFrac + 0.55 * early));
  }

  const marginMult = 1 + (win ? 0.6 * marginScore : 0.9 * badness);
  let delta = raw * marginMult;

  // Keep a single match's swing sane, and never let a win score negative / a loss positive.
  if (win) delta = Math.max(6, Math.min(45, delta));
  else delta = Math.min(-6, Math.max(-40, delta));

  return {
    delta: Math.round(delta),
    win, placement: myPlace, players: n,
    marginScore: Math.round(marginScore * 100) / 100,
    badness: Math.round(badness * 100) / 100,
    breakdown,
  };
}

/** Apply a delta with the soft floor. Returns the new trophy count. */
export function applyDelta(trophies, delta) {
  let next = trophies + delta;
  if (delta < 0) next = Math.max(next, floorFor(trophies));
  return Math.max(0, Math.round(next));
}

/* --------------------------------------------------------------- profile -- */

const PROFILE_KEY = 'bust.rank.v1';
const FRESH = { trophies: 0, best: 0, played: 0, won: 0, streak: 0 };

export function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return { ...FRESH, ...raw };
  } catch { return { ...FRESH }; }
}

export function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

/**
 * Fold a finished match into the stored profile.
 * @returns {{ profile:object, result:object, promotedFrom:?object, promotedTo:?object,
 *             demotedTo:?object }}
 */
export function recordMatch(profile, result) {
  const beforeIdx = rankIndexFor(profile.trophies);
  const trophies = applyDelta(profile.trophies, result.delta);
  const afterIdx = rankIndexFor(trophies);

  const next = {
    trophies,
    best: Math.max(profile.best, trophies),
    played: profile.played + 1,
    won: profile.won + (result.win ? 1 : 0),
    streak: result.win ? Math.max(1, profile.streak + 1) : Math.min(-1, profile.streak - 1),
  };

  return {
    profile: next,
    result,
    promotedTo: afterIdx > beforeIdx ? RANKS[afterIdx] : null,
    demotedTo: afterIdx < beforeIdx ? RANKS[afterIdx] : null,
    promotedFrom: afterIdx !== beforeIdx ? RANKS[beforeIdx] : null,
  };
}
