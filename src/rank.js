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
 * `opponents` is the number of BOTS (total players = opponents + 1, capped at 4).
 * `board` indexes BOARD_SIZES[totalPlayers]. `pool` is the difficulty draw.
 */
export const RANKS = [
  { key: 'wood',     name: 'Woodline',   min: 0,    opponents: 1, board: 'small',  pool: ['easy'] },
  { key: 'stone',    name: 'Stoneworks', min: 120,  opponents: 1, board: 'medium', pool: ['easy', 'medium'] },
  { key: 'bronze',   name: 'Bronze',     min: 300,  opponents: 2, board: 'small',  pool: ['medium'] },
  { key: 'iron',     name: 'Ironhold',   min: 520,  opponents: 2, board: 'medium', pool: ['medium', 'hard'] },
  { key: 'silver',   name: 'Silver',     min: 800,  opponents: 2, board: 'large',  pool: ['hard'] },
  { key: 'gold',     name: 'Gold',       min: 1150, opponents: 3, board: 'small',  pool: ['hard', 'expert'] },
  { key: 'platinum', name: 'Platinum',   min: 1550, opponents: 3, board: 'medium', pool: ['expert'] },
  { key: 'diamond',  name: 'Diamond',    min: 2000, opponents: 3, board: 'medium', pool: ['expert', 'brutal'] },
  { key: 'master',   name: 'Master',     min: 2600, opponents: 3, board: 'large',  pool: ['brutal'] },
  { key: 'legend',   name: 'Legend',     min: 3300, opponents: 3, board: 'large',  pool: ['brutal'] },
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
 * Build the next ranked match for a player sitting on `trophies`.
 *
 * @param {number} trophies
 * @param {(count:number)=>[number,number]} boardFor  maps player count -> [cols, rows]
 *        using the app's BOARD_SIZES + a size key.
 * @param {() => number} [rnd]
 * @returns {{ rankKey:string, cols:number, rows:number,
 *             players:Array<{name,kind,difficulty}>, ratings:number[] }}
 *          `players[0]` / `ratings[0]` are the human.
 */
export function matchmake(trophies, boardFor, rnd = Math.random) {
  const rank = rankFor(trophies);
  const botCount = Math.min(3, rank.opponents);
  const total = botCount + 1;
  const [cols, rows] = boardFor(total, rank.board);

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
  return { rankKey: rank.key, cols, rows, players, ratings };
}

/** Deterministic matchmaking for a given match number — keeps tests stable. */
export function matchmakeSeeded(trophies, boardFor, matchNo) {
  return matchmake(trophies, boardFor, mulberry32((trophies | 0) * 2654435761 + matchNo));
}

/* ----------------------------------------------------------------- scoring -- */

const expectedScore = (mine, theirs) => 1 / (1 + 10 ** ((theirs - mine) / 400));

function kFactor(trophies, played) {
  if (played < 10) return 60;      // placement games move fast
  if (trophies >= RANKS[8].min) return 28; // Master+
  return 40;
}

/**
 * Finishing order, best first. `placement[pid]` = 1 (winner) .. n (first out).
 * Losers are ranked by how long they lasted (`elimTurn`, higher = later).
 */
export function placements(state, elimTurn) {
  const n = state.players.length;
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(i);
  ids.sort((a, b) => {
    if (a === state.winner) return -1;
    if (b === state.winner) return 1;
    return (elimTurn[b] || 0) - (elimTurn[a] || 0); // lasted longer => better
  });
  const place = new Array(n).fill(n);
  ids.forEach((pid, i) => { place[pid] = i + 1; });
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
  const win = state.winner === myId;
  const myRating = ratings[myId];

  // Elo, averaged over every opponent as an implicit 1v1 (placed above => 1).
  const breakdown = [];
  let sum = 0;
  for (let pid = 0; pid < n; pid++) {
    if (pid === myId) continue;
    const result = myPlace < place[pid] ? 1 : myPlace > place[pid] ? 0 : 0.5;
    const expected = expectedScore(myRating, ratings[pid]);
    breakdown.push({ oppId: pid, oppRating: ratings[pid], expected, result });
    sum += result - expected;
  }
  const raw = kFactor(trophies, played) * (sum / breakdown.length);

  // How one-sided was it?
  const boardTiles = state.cols * state.rows;
  const finalTurn = Math.max(1, state.turnNumber);
  let myTiles = 0;
  for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === myId) myTiles++;

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
