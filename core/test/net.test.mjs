/**
 * The online party protocol, driven over a fake PeerJS network.
 *
 * Real WebRTC needs a signalling server and two browsers, which is exactly why
 * this layer went untested and exactly why it drifted. Everything that made
 * online feel flaky lives in the bookkeeping — seat indices after somebody
 * leaves, whose ready tick is whose, what a client is told and when — and all
 * of that is testable against a loopback `Peer` in one process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ fake peerjs -- */

/** Deliver everything on a later turn, the way a real connection would. */
const soon = (fn) => setTimeout(fn, 0);
const settle = () => new Promise((r) => setTimeout(r, 5));

class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) { (this._h.get(evt) || this._h.set(evt, []).get(evt)).push(fn); return this; }
  emit(evt, ...args) { for (const fn of this._h.get(evt) || []) fn(...args); }
}

class FakeConn extends Emitter {
  constructor(peer) { super(); this.peer = peer; this.open = false; this.other = null; }
  send(msg) {
    if (!this.open || !this.other || !this.other.open) return;
    // Structured-clone the payload, so a test can never pass by sharing an
    // object reference the wire would have copied.
    const copy = JSON.parse(JSON.stringify(msg));
    soon(() => this.other.emit('data', copy));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    const peer = this.other;
    soon(() => this.emit('close'));
    if (peer && peer.open) { peer.open = false; soon(() => peer.emit('close')); }
  }
}

const registry = new Map();

class FakePeer extends Emitter {
  constructor(id) {
    super();
    this.id = id || `guest-${registry.size}-${Math.random().toString(36).slice(2, 8)}`;
    this.destroyed = false;
    if (id && registry.has(id)) {
      soon(() => this.emit('error', { type: 'unavailable-id' }));
      return;
    }
    registry.set(this.id, this);
    soon(() => this.emit('open', this.id));
  }

  connect(targetId) {
    const client = new FakeConn(this);
    const host = registry.get(targetId);
    if (!host || host.destroyed) {
      soon(() => client.emit('error', new Error('peer-unavailable')));
      return client;
    }
    const server = new FakeConn(host);
    client.other = server;
    server.other = client;
    soon(() => {
      host.emit('connection', server);
      // The handlers hostRoom attaches inside `connection` must exist before
      // either side opens, which is the real ordering too. Both ends are marked
      // open before either fires, so a packet the host sends from its own
      // `open` handler still has somewhere to land.
      soon(() => {
        server.open = true;
        client.open = true;
        server.emit('open');
        client.emit('open');
      });
    });
    return client;
  }

  destroy() { this.destroyed = true; registry.delete(this.id); }
}

globalThis.window = { Peer: FakePeer };
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const { hostRoom, joinRoom, cleanName, normaliseCode, MAX_PARTY } = await import('../../web/src/net.js');

/* ------------------------------------------------------------- harness -- */

function recorder() {
  const seen = { lobby: [], start: [], move: [], ended: [], error: [] };
  return {
    seen,
    handlers: {
      onLobby: (i) => seen.lobby.push(i),
      onStart: (i) => seen.start.push(i),
      onMove: (i) => seen.move.push(i),
      onEnded: (i) => seen.ended.push(i),
      onError: (e) => seen.error.push(e.message),
    },
    last: (k) => seen[k][seen[k].length - 1],
  };
}

/** A host plus `n` joined clients, all settled. */
async function party(n, capacity = MAX_PARTY) {
  const h = recorder();
  const room = await hostRoom({ capacity, name: 'Ana', handlers: h.handlers });
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = recorder();
    const conn = await joinRoom({ code: room.code, name: `Guest${i + 1}`, handlers: c.handlers });
    clients.push({ conn, ...c });
    await settle();
  }
  await settle();
  return { room, host: h, clients };
}

const names = (rec) => rec.last('lobby').roster.map((r) => r.name);

/* ------------------------------------------------------------------ tests -- */

test('cleanName keeps a name renderable and short', () => {
  assert.equal(cleanName('  Ana  '), 'Ana');
  assert.equal(cleanName(''), 'Player');
  assert.equal(cleanName(null, 'Player 3'), 'Player 3');
  assert.equal(cleanName('a'.repeat(40)).length, 14);
  assert.equal(cleanName('bad\u0000na\u001Fme'), 'badname', 'control characters stripped');
  assert.equal(cleanName('two   spaces'), 'two spaces');
});

test('normaliseCode is forgiving about how a code is typed', () => {
  assert.equal(normaliseCode('ab-cd e'), 'ABCDE');
  assert.equal(normaliseCode('abcdefgh'), 'ABCDE');
  assert.equal(normaliseCode(null), '');
});

test('everyone in the party sees everyone else, by name', async () => {
  const { room, host, clients } = await party(2);
  assert.deepEqual(names(host), ['Ana', 'Guest1', 'Guest2']);
  for (const c of clients) assert.deepEqual(names(c), ['Ana', 'Guest1', 'Guest2']);
  assert.equal(clients[0].last('lobby').seat, 1);
  assert.equal(clients[1].last('lobby').seat, 2);
  assert.equal(room.playerCount(), 3);
  room.destroy();
});

test('renaming yourself repaints the whole party', async () => {
  const { room, host, clients } = await party(1);
  clients[0].conn.setName('Bo');
  await settle();
  assert.deepEqual(names(host), ['Ana', 'Bo']);
  assert.deepEqual(names(clients[0]), ['Ana', 'Bo']);

  room.setName('Ana B');
  await settle();
  assert.deepEqual(names(clients[0]), ['Ana B', 'Bo']);
  room.destroy();
});

test('a round starts only once every seat has ticked ready', async () => {
  const { room, host, clients } = await party(1);
  assert.equal(room.everyoneReady(), false, 'nobody has readied');

  clients[0].conn.setReady(true);
  await settle();
  assert.equal(room.everyoneReady(), false, 'the host has not');
  assert.deepEqual(host.last('lobby').roster.map((r) => r.ready), [false, true]);

  room.setReady(true);
  await settle();
  assert.equal(room.everyoneReady(), true);

  // Un-ticking is honoured too — a vote you can't take back isn't a vote.
  clients[0].conn.setReady(false);
  await settle();
  assert.equal(room.everyoneReady(), false);
  room.destroy();
});

test('a lone host is never "everyone ready"', async () => {
  const { room } = await party(0);
  room.setReady(true);
  await settle();
  assert.equal(room.everyoneReady(), false, 'a party of one is not a party');
  room.destroy();
});

test('start hands every client the same config and clears the ready ticks', async () => {
  const { room, host, clients } = await party(2);
  room.setReady(true);
  clients[0].conn.setReady(true);
  clients[1].conn.setReady(true);
  await settle();

  const config = { cols: 9, rows: 9, modeKey: 'chaos', teams: null, blocked: [0, 1, 0], bounce: true };
  const players = [{ name: 'Ana' }, { name: 'Guest1' }, { name: 'Guest2' }];
  room.start(config, players);
  await settle();

  for (const c of clients) {
    assert.deepEqual(c.last('start').config, config);
    assert.deepEqual(c.last('start').players, players);
  }
  assert.equal(clients[0].last('start').seat, 1, 'a client plays the seat it was given');
  assert.equal(room.everyoneReady(), false, 'the next vote starts clean');

  // And the room is closed to newcomers while a round is live.
  const late = recorder();
  await joinRoom({ code: room.code, name: 'Late', handlers: late.handlers }).catch(() => {});
  await settle();
  assert.match(late.last('error') || '', /mid-game/);
  assert.equal(host.last('lobby').roster.length, 3, 'the late joiner never took a seat');
  room.destroy();
});

test('a move is relayed with the seat that sent it, so the host can referee', async () => {
  const { room, host, clients } = await party(1);
  room.start({ cols: 7, rows: 7 }, [{ name: 'Ana' }, { name: 'Guest1' }]);
  await settle();

  clients[0].conn.sendMove(17);
  await settle();
  assert.deepEqual(host.last('move'), { idx: 17, from: 1 });

  // Clients apply only what the host echoes, which is what keeps them in step.
  room.sendMove(17, 1);
  await settle();
  assert.deepEqual(clients[0].last('move'), { idx: 17, by: 1 });
  room.destroy();
});

test('someone leaving the lobby compacts the seats and tells the rest', async () => {
  const { room, host, clients } = await party(2);
  clients[0].conn.destroy();          // seat 1 walks out before the round
  await settle();

  assert.deepEqual(names(host), ['Ana', 'Guest2']);
  assert.equal(clients[1].last('lobby').seat, 1, 'seat 2 moved up to seat 1');

  // The moved player is still the one the host hears from.
  clients[1].conn.setName('Cy');
  await settle();
  assert.deepEqual(names(host), ['Ana', 'Cy']);
  room.destroy();
});

test('someone leaving mid-round ends the round, not the party', async () => {
  const { room, host, clients } = await party(2);
  room.start({ cols: 8, rows: 8 }, [{ name: 'Ana' }, { name: 'Guest1' }, { name: 'Guest2' }]);
  await settle();

  clients[0].conn.destroy();
  await settle();
  assert.equal(host.last('ended').mid, true);
  assert.match(host.last('ended').reason, /Guest1/);

  room.endRound(host.last('ended').reason);
  await settle();
  assert.match(clients[1].last('ended').reason, /Guest1/);
  // The party carries on with whoever is left, re-seated and un-readied.
  assert.deepEqual(names(host), ['Ana', 'Guest2']);
  assert.equal(clients[1].last('lobby').seat, 1);
  assert.equal(clients[1].last('lobby').started, false);
  room.destroy();
});

test('openParty reopens the room between rounds without evicting anyone', async () => {
  const { room, host, clients } = await party(1);
  room.setReady(true);
  clients[0].conn.setReady(true);
  await settle();
  room.start({ cols: 7, rows: 7 }, [{ name: 'Ana' }, { name: 'Guest1' }]);
  await settle();

  room.openParty();
  await settle();
  assert.equal(clients[0].seen.ended.length, 0, 'nobody is yanked off the result card');
  assert.deepEqual(host.last('lobby').roster.map((r) => r.ready), [false, false]);

  // Joinable again, so a friend can turn up between rounds.
  const late = recorder();
  await joinRoom({ code: room.code, name: 'Dee', handlers: late.handlers });
  await settle();
  assert.deepEqual(names(host), ['Ana', 'Guest1', 'Dee']);
  room.destroy();
});

test('a full party turns the next person away', async () => {
  const { room, host } = await party(1, 2);
  const late = recorder();
  await joinRoom({ code: room.code, name: 'Late', handlers: late.handlers }).catch(() => {});
  await settle();
  assert.match(late.last('error') || '', /full/);
  assert.equal(host.last('lobby').roster.length, 2);
  room.destroy();
});
