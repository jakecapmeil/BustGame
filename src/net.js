/**
 * BUST — online play over WebRTC (PeerJS).
 *
 * The unit here is a **party**, not a match. A room is a group of people that
 * persists across rounds: they name themselves, tick ready, play, and then tick
 * ready again for the next round — the host can swap the map in between and
 * nobody has to be re-invited. So the room outlives any single game, and
 * `start` is something that happens repeatedly on a room rather than once.
 *
 * The host is authoritative but thin: because the engine is deterministic, the
 * only thing that crosses the wire during a round is an ordered stream of move
 * indices. Every client replays that stream through the same `applyMove` and
 * lands on an identical board, so there is no state to sync and nothing to
 * reconcile.
 *
 * PeerJS is loaded on demand, so nothing here touches the offline/solo path.
 */

const PEERJS_SRC = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const ROOM_PREFIX = 'bustgame-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes

/** Hard ceiling on a party, matching `MAX_SEATS` in modes.js. */
export const MAX_PARTY = 8;

let peerLibPromise = null;

function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (peerLibPromise) return peerLibPromise;
  peerLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_SRC;
    s.crossOrigin = 'anonymous';
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS failed to initialise')));
    s.onerror = () => reject(new Error('Could not reach the multiplayer service'));
    document.head.appendChild(s);
  });
  return peerLibPromise;
}

export function randomCode(n = 5) {
  let out = '';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

export function normaliseCode(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

/**
 * A player name that is safe to render and short enough for a lobby row.
 * Names arrive off the wire, so they are sanitised on receipt rather than
 * trusted — control characters out, length capped, never empty.
 */
export function cleanName(raw, fallback = 'Player') {
  const n = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return n || fallback;
}

function makePeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, { debug: 0 });
    const timer = setTimeout(() => reject(new Error('Connection timed out')), 15000);
    peer.on('open', () => { clearTimeout(timer); resolve(peer); });
    peer.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(
        e && e.type === 'unavailable-id' ? 'That room code is taken — try again'
        : e && e.type === 'peer-unavailable' ? 'No room with that code'
        : 'Connection failed',
      ));
    });
  });
}

/* -------------------------------------------------------------------- host -- */

/**
 * Open a room and keep it open across rounds.
 *
 * @param {object} opts
 * @param {number} opts.capacity   most people the party may hold
 * @param {string} opts.name       the host's own display name
 * @param {object} opts.handlers   {onLobby, onMove, onEnded, onError}
 */
export async function hostRoom({ capacity = MAX_PARTY, name, handlers }) {
  const Peer = await loadPeerJS();
  const code = randomCode();
  const peer = await makePeer(Peer, ROOM_PREFIX + code);

  /** Seat 0 is the host, so it has no connection of its own. */
  const seats = [{ conn: null, name: cleanName(name, 'Player 1'), ready: false }];
  let started = false;

  const roster = () => seats.map((s, i) => ({
    name: s.name, ready: s.ready, host: i === 0, gone: !!s.gone,
  }));

  const broadcast = (msg) => {
    for (const s of seats) {
      if (s && s.conn && s.conn.open) { try { s.conn.send(msg); } catch { /* dropped */ } }
    }
  };

  /**
   * Push the roster to everyone. Each client needs its own seat index, so the
   * packet is personalised rather than broadcast.
   */
  const pushLobby = () => {
    const list = roster();
    for (let i = 1; i < seats.length; i++) {
      const c = seats[i] && seats[i].conn;
      if (c && c.open) {
        try { c.send({ t: 'lobby', you: i, code, capacity, started, roster: list }); } catch { /* dropped */ }
      }
    }
    handlers.onLobby?.({ roster: list, capacity, seat: 0, started });
  };

  const room = {
    code,
    isHost: true,
    seat: 0,
    capacity,
    peer,
    started: () => started,
    roster,
    playerCount: () => seats.filter(Boolean).length,
    broadcast,
  };

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      if (started || room.playerCount() >= capacity) {
        try { conn.send({ t: 'full', started }); } catch { /* ignore */ }
        setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 250);
        return;
      }
      const seat = seats.length;
      conn.metadata_seat = seat;
      seats.push({ conn, name: `Player ${seat + 1}`, ready: false });
      pushLobby();
    });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const seat = conn.metadata_seat;
      const me = seats[seat];
      if (!me || me.conn !== conn) return;   // a packet from a dropped seat
      switch (msg.t) {
        case 'hello':
        case 'name':
          me.name = cleanName(msg.name, `Player ${seat + 1}`);
          pushLobby();
          break;
        case 'ready':
          me.ready = !!msg.on;
          pushLobby();
          break;
        case 'move':
          // The host is the referee. Validation happens where the board lives,
          // so all this does is hand the packet over with its sender attached.
          handlers.onMove?.({ idx: msg.idx, from: seat });
          break;
        default: break;
      }
    });

    const drop = () => {
      const seat = conn.metadata_seat;
      if (seat === undefined || !seats[seat] || seats[seat].conn !== conn) return;
      if (started) {
        // Mid-round the seat indices are load-bearing — every client is
        // replaying a move stream keyed to them — so the seat stays put and
        // the round ends instead.
        seats[seat] = { conn: null, name: seats[seat].name, ready: false, gone: true };
        handlers.onEnded?.({ reason: `${seats[seat].name} left the game`, mid: true });
      } else {
        // Before a round, compact the lobby so seat numbers stay contiguous.
        seats.splice(seat, 1);
        for (let i = 1; i < seats.length; i++) {
          if (seats[i].conn) seats[i].conn.metadata_seat = i;
        }
        pushLobby();
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (e) => {
    if (e && e.type === 'peer-unavailable') return; // a client vanished; already handled
    handlers.onError?.(new Error('Connection lost'));
  });

  /** The host's own name and ready tick go through the same roster. */
  room.setName = (n) => { seats[0].name = cleanName(n, 'Player 1'); pushLobby(); };
  room.setReady = (on) => { seats[0].ready = !!on; pushLobby(); };
  room.everyoneReady = () => {
    const live = seats.filter((s) => s && !s.gone);
    return live.length >= 2 && live.every((s) => s.ready);
  };

  /** Host confirms a validated move to everyone. */
  room.sendMove = (idx, by) => broadcast({ t: 'move', idx, by });

  /**
   * Deal a round. Ready ticks reset on the way out, so "play again" starts
   * from a clean slate every time rather than carrying the last round's.
   */
  room.start = (config, players) => {
    started = true;
    for (const s of seats) if (s) s.ready = false;
    broadcast({ t: 'start', config, players });
  };

  /**
   * Between rounds. The party is joinable again, anyone who dropped is swept
   * up, and nobody is ready — so "play again" starts from a clean vote.
   *
   * Deliberately silent: after a round ends normally every client is sitting on
   * the result card casting that vote, and an `ended` packet would yank them
   * off it.
   */
  room.openParty = () => {
    started = false;
    for (let i = seats.length - 1; i >= 1; i--) if (seats[i] && seats[i].gone) seats.splice(i, 1);
    for (let i = 1; i < seats.length; i++) if (seats[i].conn) seats[i].conn.metadata_seat = i;
    for (const s of seats) if (s) s.ready = false;
    pushLobby();
  };

  /** A round abandoned rather than finished: everyone back to the lobby. */
  room.endRound = (reason = '') => {
    broadcast({ t: 'ended', reason });
    room.openParty();
  };

  room.destroy = () => {
    try { broadcast({ t: 'bye' }); } catch { /* ignore */ }
    setTimeout(() => { try { peer.destroy(); } catch { /* ignore */ } }, 120);
  };

  handlers.onLobby?.({ roster: roster(), capacity, seat: 0, started });
  return room;
}

/* ------------------------------------------------------------------ client -- */

export async function joinRoom({ code, name, handlers }) {
  const Peer = await loadPeerJS();
  const peer = await makePeer(Peer, null);

  return new Promise((resolve, reject) => {
    // Leave serialization at the PeerJS default so both ends negotiate the same
    // codec — an explicit mismatch here silently garbles every packet.
    const conn = peer.connect(ROOM_PREFIX + code, { reliable: true });
    const timer = setTimeout(() => {
      try { peer.destroy(); } catch { /* ignore */ }
      reject(new Error('No room with that code'));
    }, 15000);

    let seat = null;
    let settled = false;
    const send = (msg) => { if (conn.open) { try { conn.send(msg); } catch { /* dropped */ } } };

    conn.on('open', () => {
      clearTimeout(timer);
      settled = true;
      send({ t: 'hello', name: cleanName(name) });
      resolve({
        code,
        isHost: false,
        peer,
        get seat() { return seat; },
        setName: (n) => send({ t: 'name', name: cleanName(n) }),
        setReady: (on) => send({ t: 'ready', on: !!on }),
        sendMove: (idx) => send({ t: 'move', idx }),
        destroy: () => {
          try { conn.close(); } catch { /* ignore */ }
          try { peer.destroy(); } catch { /* ignore */ }
        },
      });
    });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'lobby':
          seat = msg.you;
          handlers.onLobby?.({
            roster: Array.isArray(msg.roster) ? msg.roster : [],
            capacity: msg.capacity,
            seat,
            started: !!msg.started,
          });
          break;
        case 'start':   handlers.onStart?.({ ...msg, seat }); break;
        case 'move':    handlers.onMove?.({ idx: msg.idx, by: msg.by }); break;
        case 'ended':   handlers.onEnded?.({ reason: msg.reason || '' }); break;
        case 'full':
          handlers.onError?.(new Error(msg.started
            ? 'That party is mid-game — try again in a minute'
            : 'That party is full'));
          break;
        case 'bye':     handlers.onError?.(new Error('The host closed the room')); break;
        default: break;
      }
    });

    const bail = () => {
      clearTimeout(timer);
      if (settled) handlers.onError?.(new Error('Lost connection to the host'));
      else reject(new Error('No room with that code'));
    };
    conn.on('close', bail);
    conn.on('error', bail);
    peer.on('error', bail);
  });
}
