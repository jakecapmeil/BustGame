# Server-authoritative ranked, on Cloudflare

How to turn the current **solo** trophy ladder into a real online one — matched
opponents, trophies the client can't forge, a leaderboard — without giving up the
things that make BUST cheap to run (static front end, no build step, a pure engine).

This is a design, not code that ships today. It's written so someone can pick it up
and build it in phases.

---

## The one idea that makes this easy

`src/engine.js` and `src/rank.js` are **pure ES modules** — no DOM, no Node APIs, no
`localStorage` in the hot path. They already run in a browser tab with nothing else.
They will run **unchanged inside a Cloudflare Worker**.

So the server doesn't need a reimplementation of the rules or the scoring. It imports
the same files, keeps the authoritative `createGame(...)` state, validates every move
with `isLegalMove`, applies it with `applyMove`, and at game over calls the same
`scoreResult()` the client uses today — except now the inputs (`ratings`, `elimTurn`,
who won) are all server-held and unfakeable.

`src/ai.js` imports only the engine, so the server can also **fill an empty seat with
a bot** when matchmaking is thin. Same scoring applies — the bot stands in for an
absent human of a given rating.

Keep those three files dependency-free forever. Add a CI check that greps them for
`document`, `window`, `localStorage`, `require(`.

---

## Why Durable Objects

A ranked match is a small piece of **strongly consistent, coordinated state** with
**persistent connections** and **per-match scheduled work** (turn clock, forfeit
timer). That is the exact shape Durable Objects are for. One DO instance = one match =
the single authority for that game. No locking, no race between clients, no polling.

The alternative — a stateless Worker over D1/KV with clients polling — loses on every
axis: latency, cost of the poll loop, and races on the trophies row. Don't.

You'll run two DO classes and a plain Worker in front:

| Piece | Kind | Responsibility |
|---|---|---|
| `api` | Worker | HTTP: sessions, profile, leaderboard, match history. Routes the WebSocket upgrade to a `MatchRoom`. Nothing stateful. |
| `Matchmaker` | Durable Object (a few, sharded by rating band) | Holds the waiting queue. Pairs players within a trophy window that widens over time. Spawns a `MatchRoom`, hands both clients its id + seat. Bot-fills on timeout. |
| `MatchRoom` | Durable Object (one per match) | The authoritative game. Owns engine state, WebSockets to the seated players, the turn clock, forfeit logic. On game over: scores with `rank.js`, writes trophy deltas to D1 atomically. |

Storage:

| Store | Use |
|---|---|
| **D1** (SQLite) | Durable record of truth: `players`, `matches`, `match_players`. Queryable for history + leaderboard. |
| **DO SQLite storage** (`ctx.storage.sql`) | In-match state: seat table, move log, settlement latch. Rehydrates if the DO is evicted. |
| **KV** | Hot reads only: a precomputed leaderboard snapshot, rebuilt on a cron trigger. |
| **Secrets** | `HMAC_SECRET` for signing session/match tokens. |

---

## Data model (D1)

```sql
-- migrations/0001_init.sql
CREATE TABLE players (
  id            TEXT PRIMARY KEY,          -- opaque, server-minted
  handle        TEXT NOT NULL,
  trophies      INTEGER NOT NULL DEFAULT 0,
  best          INTEGER NOT NULL DEFAULT 0,
  played        INTEGER NOT NULL DEFAULT 0,
  won           INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  auth_provider TEXT,                      -- null = anonymous device account
  auth_subject  TEXT,                      -- set when a login is linked later
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX players_trophies ON players (trophies DESC);
CREATE UNIQUE INDEX players_auth ON players (auth_provider, auth_subject)
  WHERE auth_provider IS NOT NULL;

CREATE TABLE matches (
  id          TEXT PRIMARY KEY,
  rank_key    TEXT NOT NULL,
  config      TEXT NOT NULL,               -- JSON: {cols, rows, seed}
  bot_filled  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  result      TEXT                         -- JSON standings; NULL until settled
);

CREATE TABLE match_players (
  match_id      TEXT NOT NULL REFERENCES matches(id),
  player_id     TEXT REFERENCES players(id), -- NULL for a bot seat
  seat          INTEGER NOT NULL,
  rating_before INTEGER NOT NULL,
  placement     INTEGER,
  delta         INTEGER,
  rating_after  INTEGER,
  PRIMARY KEY (match_id, seat)
);
```

`match_players` doubles as an append-only audit log. With the seed + move list (kept
in the `MatchRoom`'s own SQLite, optionally flushed to R2), any match is
deterministically replayable for dispute resolution.

---

## Identity / auth

Pick the low-friction option and leave a door open.

1. **Anonymous device account — recommended to launch.** First run, the client
   `POST /v1/session` with nothing. The Worker mints `player_id` + a short-lived
   signed token (HMAC over `{player_id, exp}` with `HMAC_SECRET`), inserts a `players`
   row, returns both. Client stores `player_id` + a long-lived refresh token in
   `localStorage` (same place the profile lives now). Zero friction, matches the
   current "no accounts" feel.
   *Cost:* lose the device, lose the trophies. Mitigate with a "link code" (device A
   shows a code, device B enters it, server merges — keep the higher trophy count).
2. **Real login later.** The schema already has `auth_provider` / `auth_subject`.
   Add an OAuth flow in the Worker (Google / Apple / GitHub) or drop in Clerk /
   Auth0 / Cloudflare Access. "Claim this account" links the anonymous row to a
   subject; nothing else changes.
3. **Passkeys / WebAuthn.** Nicer long-term, more to build. Not for v1.

Everything below assumes a valid `player_id` from a verified token on every request
and every WebSocket open.

---

## Matchmaking

`Matchmaker` DOs are sharded by coarse rating band (`getByName("mm:" + Math.floor(T/400))`)
so no single queue is a bottleneck; a band DO also peeks at its neighbours when thin.

Queue entry: `{ playerId, trophies: T, joinedAt, ws }` (the client holds a WebSocket
to the Matchmaker while waiting, or long-polls `GET /v1/queue`).

On every new entrant **and** on an `alarm()` tick (~2s):

```
for each waiting pair (a, b), oldest first:
  window = 50 + 15 * secondsWaiting(older of a,b)   // capped ~600
  if |a.T - b.T| <= window: form a match
```

- **v1 is 1-v-1 only.** It's symmetric and sidesteps "3 humans, one AFK". The
  `RANKS[*].opponents` field already describes FFA sizes — wire those up in a later
  phase for FFA ranked.
- **Bot fill.** If a player has waited > ~20s with no pairing, start a `MatchRoom`
  with one human seat and one bot seat. Bot difficulty comes from
  `rankFor(T).pool`; bot rating = `T ± jitter`. Mark `matches.bot_filled = 1`.
  This is precisely today's solo ranked — only the referee moved to the server.
- A player can be in **one** ranked match at a time. Matchmaker marks them "engaged"
  in DO storage and rejects re-queue until the `MatchRoom` reports done. This is also
  what removes the only possible write race on the `players.trophies` row.

To start a match the Matchmaker:

```ts
const matchId = crypto.randomUUID();
const room = this.env.MATCH.getByName(matchId);
const seed = crypto.getRandomValues(new Uint32Array(1))[0];
await room.init({ matchId, seed, seats: [
  { seat: 0, playerId: a.playerId, rating: a.T, kind: "human" },
  { seat: 1, playerId: b.playerId, rating: b.T, kind: "human" },
]});
// tell each client where to connect
a.ws.send(JSON.stringify({ t: "matched", matchId, seat: 0, wsUrl: `/v1/match/${matchId}` }));
b.ws.send(JSON.stringify({ t: "matched", matchId, seat: 1, wsUrl: `/v1/match/${matchId}` }));
```

---

## The match room

```ts
import { DurableObject } from "cloudflare:workers";
import { createGame, applyMove, isLegalMove, PHASE_OVER } from "../../src/engine.js";
import { scoreResult } from "../../src/rank.js";
import { chooseMove } from "../../src/ai.js";

const TURN_MS = 20_000;
const RECONNECT_GRACE_MS = 30_000;

export class MatchRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS moves (seq INTEGER PRIMARY KEY, seat INTEGER, idx INTEGER)`);
    });
  }

  // RPC from the Matchmaker
  async init(cfg: MatchConfig) {
    const [cols, rows] = boardForRank(cfg);                 // from RANKS + a size key
    const state = createGame({ cols, rows, players: cfg.seats.map(seatToPlayer) });
    this.#save("config", { ...cfg, cols, rows });
    this.#save("state", serialize(state));                  // typed arrays -> plain arrays
    this.#save("elimTurn", {});
    await this.ctx.storage.setAlarm(Date.now() + TURN_MS);  // opening clock
  }

  // WebSocket upgrade lands here (routed by the api Worker)
  async fetch(req: Request) {
    const seat = this.#verifySeatToken(new URL(req.url).searchParams.get("token"));
    if (seat == null) return new Response("bad token", { status: 401 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [`seat:${seat}`]);     // hibernatable
    server.serializeAttachment({ seat });
    this.#sendWelcome(server, seat);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string) {
    const { seat } = ws.deserializeAttachment();
    const msg = JSON.parse(raw);
    if (msg.t !== "move") return;
    this.#rateLimit(seat);                                  // e.g. 5 moves / sec / seat

    const state = deserialize(this.#load("state"));
    if (state.turn !== seat || !isLegalMove(state, msg.idx)) return; // drop, like net.js

    const r = applyMove(state, msg.idx);
    if (!r.ok) return;
    const seq = this.#appendMove(seat, msg.idx);
    this.#save("state", serialize(r.state));
    this.#trackElim(r.state);
    this.#broadcast({ t: "move", seat, idx: msg.idx, seq });

    if (r.state.phase === PHASE_OVER) return this.#settle(r.state);
    this.#save("state-turn-owner", r.state.turn);
    this.ctx.storage.setAlarm(Date.now() + TURN_MS);
  }

  async alarm() {
    const state = deserialize(this.#load("state"));
    if (state.phase === PHASE_OVER) return;
    // Turn expired. No "pass" in BUST, so auto-play a safe move for the laggard,
    // count a strike, and forfeit after a few.
    const strikes = this.#bumpStrike(state.turn);
    if (strikes >= 3 || this.#seatGoneParkedPast(RECONNECT_GRACE_MS, state.turn)) {
      return this.#forfeit(state.turn);
    }
    const idx = chooseMove(state, "easy") ?? firstLegal(state);
    const r = applyMove(state, idx);
    this.#appendMove(state.turn, idx);
    this.#save("state", serialize(r.state));
    this.#broadcast({ t: "move", seat: state.turn, idx, seq: this.#seq(), auto: true });
    if (r.state.phase === PHASE_OVER) return this.#settle(r.state);
    await this.ctx.storage.setAlarm(Date.now() + TURN_MS);
  }

  #settle(state) {
    if (this.#load("settled")) return;                      // idempotency latch
    this.#save("settled", true);
    const cfg = this.#load("config");
    const elimTurn = this.#load("elimTurn");
    const ratings = cfg.seats.map((s) => s.rating);

    const rows = cfg.seats.map((s) => {
      if (s.kind === "bot") return null;
      const res = scoreResult({ state, myId: s.seat, ratings, elimTurn,
        trophies: s.rating, played: s.played ?? 50 });
      return { seat: s.seat, playerId: s.playerId, before: s.rating, res };
    }).filter(Boolean);

    // One atomic D1 batch: update each player, write the match + rows.
    this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE players SET trophies=?, best=MAX(best,?), played=played+1,
           won=won+?, streak=?, updated_at=? WHERE id=?`
      ).bind(/* per row, computed via rank.applyDelta / recordMatch */),
      // ... match_players inserts, matches update set result=?, ended_at=?
    ]);

    this.#broadcast({ t: "result", standings: /* ... */, deltas: /* ... */ });
    this.env.MATCHMAKER.getByName(cfg.mmShard).release(cfg.seats.map(s => s.playerId));
  }
}
```

Notes that matter:

- **Persist before you broadcast.** Write `state` to storage, then send the `move`.
  If the DO is evicted between, the move log + `settled` latch rebuild the truth.
- **Idempotent settle.** The `settled` flag is written *before* the D1 batch. A
  retried `alarm()` or a restart mid-write re-runs the batch, which is keyed by
  `match_id` and guarded by `result IS NULL`, so it can't double-apply trophies.
- **No cross-match race.** Matchmaker guarantees a player is in one match; the
  `MatchRoom` is the only writer of that player's row for the match's duration.
- **Hibernation.** `ctx.acceptWebSocket` + `serializeAttachment` means an idle match
  (players thinking) costs no wall-clock — important for a slow turn-based game.
- The client already funnels every move through one serial queue and applies `'net'`
  moves via `enqueue(idx, 'net')`. Server messages keep that shape.

---

## Wire protocol (match WebSocket)

Client → server: `{t:"hello", token}` · `{t:"move", idx}` · `{t:"resync"}` · `{t:"ping"}`

Server → client:
- `{t:"welcome", seat, seed, config:{cols,rows}, players:[{seat,name,rating}], moves:[{seat,idx}]}`
- `{t:"move", seat, idx, seq, auto?}`
- `{t:"clock", seat, deadline}` — server is the only clock
- `{t:"result", standings:[{seat,placement}], deltas:[{seat,delta,after}], profile}`
- `{t:"opponentLeft", seat, graceEndsAt}` · `{t:"error", code}`

`seq` is monotonic. On a gap the client sends `{t:"resync"}`; the server replies with
the full `moves` array and the client **replays from `createGame` via its own
`applyMove`** — deterministic, so it lands byte-identical. This is the same "only move
indices cross the wire" contract `net.js` already has; reconnection is just a resync.

---

## What changes in the existing client

| File | Change |
|---|---|
| `src/net.js` | Add a WebSocket transport alongside (or replacing) PeerJS: connect to `wss://api.<domain>/v1/match/<id>?token=…`, same `{t:'move'}` messages, plus reconnect-with-backoff and `resync`. |
| `src/main.js` | New "Find match" flow: `POST /v1/queue` → hold a socket to the Matchmaker → on `{t:'matched'}` call `startGame({mode:'ranked', online:true, …})`. On `{t:'result'}` render the existing trophy tally from server numbers instead of calling `settleRanked()` locally. |
| `src/rank.js` | `loadProfile`/`saveProfile` become a thin cache over `GET /v1/me`; the pure functions (`scoreResult`, `matchmake`, `recordMatch`) are untouched and now also run server-side. |
| everything else | unchanged |

Solo ranked can stay exactly as-is (offline, local trophies) or, in phase 1, start
syncing its result to `POST /v1/match/solo` so the trophy count is server-owned and
localStorage tampering stops mattering.

---

## HTTP API (the `api` Worker)

| Route | Purpose |
|---|---|
| `POST /v1/session` | Mint / refresh an anonymous account; returns `player_id` + tokens. |
| `GET /v1/me` | Profile: trophies, rank, W/L, streak. |
| `POST /v1/queue` | Enter matchmaking (body: nothing; rating comes from the row). Returns a WS URL to the Matchmaker shard. |
| `GET /v1/match/:id` | Match summary + move list (history / replay). |
| `GET /v1/leaderboard` | Top N from the KV snapshot; `?around=me` for your neighbourhood from D1. |
| `POST /v1/link` | Link an anonymous row to an OAuth subject, or merge two rows by code. |

CORS locked to the site origin. WebSocket upgrades check `Origin`. Every route
verifies the HMAC token; `/v1/match/:id` additionally checks the seat token issued by
the Matchmaker for that match.

---

## Cron triggers

- **Every ~1 min:** rebuild `KV: leaderboard:top` from `SELECT … ORDER BY trophies DESC LIMIT 100`.
- **Hourly:** sweep abandoned queue entries and `matches` with no `ended_at` older than
  ~30 min (void, no trophy change).
- **Monthly (optional, Clash-Royale-style season):** snapshot standings into a
  `seasons` table, hand out rewards by peak rank, then soft-reset:
  `new = max(rankFloor(old), round(old * 0.5))`. Don't decay for mere inactivity — it
  just annoys people.

---

## `wrangler.jsonc`

```jsonc
{
  "name": "bust-api",
  "main": "server/src/index.ts",
  "compatibility_date": "2024-09-23",
  "durable_objects": {
    "bindings": [
      { "name": "MATCH", "class_name": "MatchRoom" },
      { "name": "MATCHMAKER", "class_name": "Matchmaker" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MatchRoom", "Matchmaker"] }
  ],
  "d1_databases": [{ "binding": "DB", "database_name": "bust", "database_id": "…" }],
  "kv_namespaces": [{ "binding": "KV", "id": "…" }],
  "triggers": { "crons": ["* * * * *", "0 * * * *"] }
}
```

`HMAC_SECRET` via `wrangler secret put`. The static PWA stays on GitHub Pages, or
moves to Cloudflare Pages so front end and API share a domain and deploy — either is
fine; nothing in the game needs it.

---

## Cost

- Durable Objects require the **Workers Paid plan — $5/mo** floor. Included usage
  covers a hobby-scale game comfortably; DO billing past that is ~$0.15 / M requests
  plus GB-s of active duration (hibernation means idle matches don't accrue it).
- **D1:** free tier is 5 GB and millions of reads/day — irrelevant at this scale.
- **KV / Workers requests:** free tiers cover it.

Realistically a few dollars a month until the game is genuinely popular.

---

## Testing

- **Pure modules:** the existing `node --test` suite is the shared source of truth for
  rules and scoring — server and client both depend on it passing.
- **DO logic:** `@cloudflare/vitest-pool-workers` (Miniflare). Drive two mock
  WebSocket clients against a `MatchRoom`: assert illegal / out-of-turn moves are
  dropped, the turn `alarm()` forfeits after N strikes, the D1 batch runs once,
  and a second `#settle` is a no-op.
- **Matchmaker:** fake clock, assert the widening window and bot-fill timeout.
- **End to end:** a script that opens N WebSocket pairs against `wrangler dev`.

---

## Phased rollout

1. **Accounts + server-owned trophies.** Worker + D1 + `POST /v1/session` + `GET /v1/me`.
   Point today's solo ranked at `POST /v1/match/solo` so trophies live on the server.
   No real-time yet. Ships the anti-tamper win on its own.
2. **Real-time 1-v-1.** `Matchmaker` + `MatchRoom`, bot-fill on timeout, WebSocket
   transport in `net.js`. This is "online ranked" in the CR sense.
3. **Robustness.** Turn clock, forfeit + reconnect grace, match history, leaderboard,
   `/v1/link` for multi-device.
4. **Depth.** FFA ranked (the `RANKS[*].opponents` sizes), seasons + rewards, OAuth
   login, replay viewer off the stored move logs.

---

## Failure modes

| Situation | Handling |
|---|---|
| `MatchRoom` evicted mid-match | DO storage rehydrates `state` + move log; clients `resync` on reconnect. |
| D1 unavailable at settle | `settled` latch is set; `alarm()` retries the batch until it lands. |
| Both players drop | Grace timer fires → match voided, no trophy change. |
| One player rage-quits | Forfeit: scored as a loss with `badness` maxed; opponent gets the win at the current turn. |
| Client clock disagrees | There is no client clock — `{t:"clock"}` from the server is authoritative. |
| Duplicate `matched` / retried settle | Idempotent by `match_id`; `result IS NULL` guard on the D1 update. |
