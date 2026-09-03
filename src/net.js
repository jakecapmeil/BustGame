/**
 * BUST — online play over WebRTC (PeerJS).
 *
 * The host is authoritative but thin: because the engine is deterministic, the
 * only thing that crosses the wire is an ordered stream of move indices. Every
 * client replays that stream through the same `applyMove` and lands on an
 * identical board, so there is no state to sync and nothing to reconcile.
 *
 * PeerJS is loaded on demand, so nothing here touches the offline/solo path.
 */

const PEERJS_SRC = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const ROOM_PREFIX = 'bustgame-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes

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
 * @param {object} opts
 * @param {number} opts.capacity      total seats including the host
 * @param {object} opts.config        {cols, rows} sent to clients on start
 * @param {object} opts.handlers      {onLobby, onStart, onMove, onError, onClose}
 */
export async function hostRoom({ capacity, config, handlers }) {
  const Peer = await loadPeerJS();
  const code = randomCode();
  const peer = await makePeer(Peer, ROOM_PREFIX + code);

  /** seat index -> connection (seat 0 is the host, so no connection) */
  const seats = [null];
  let started = false;

  const room = {
    code,
    isHost: true,
    seat: 0,
    capacity,
    peer,
    started: () => started,
    playerCount: () => seats.filter(Boolean).length + 1,
  };

  const broadcast = (msg) => {
    for (const c of seats) if (c && c.open) { try { c.send(msg); } catch { /* dropped */ } }
  };
  room.broadcast = broadcast;

  const lobbyState = () => ({
    t: 'lobby',
    count: room.playerCount(),
    capacity,
  });

  const pushLobby = () => {
    for (let i = 1; i < seats.length; i++) {
      const c = seats[i];
      if (c && c.open) { try { c.send({ ...lobbyState(), you: i }); } catch { /* dropped */ } }
    }
    handlers.onLobby?.({ count: room.playerCount(), capacity, seat: 0 });
  };

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      if (started || room.playerCount() >= capacity) {
        try { conn.send({ t: 'full' }); } catch { /* ignore */ }
        setTimeout(() => conn.close(), 200);
        return;
      }
      const seat = seats.length;
      seats.push(conn);
      conn.metadata_seat = seat;
      pushLobby();
    });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const seat = conn.metadata_seat;
      if (msg.t === 'move') {
        // The host is the referee: it validates, applies, then echoes to all
        // (including the sender) so every client applies in the same order.
        handlers.onMove?.({ idx: msg.idx, from: seat });
      }
    });

    const drop = () => {
      const seat = conn.metadata_seat;
      if (seat === undefined) return;
      const wasSeated = !!seats[seat];
      seats[seat] = null;
      if (started && wasSeated) {
        broadcast({ t: 'left', seat });
        handlers.onClose?.({ seat, mid: true });
      } else if (wasSeated) {
        // Compact the lobby so seat numbers stay contiguous before the start.
        const live = seats.slice(1).filter(Boolean);
        seats.length = 1;
        for (const c of live) { c.metadata_seat = seats.length; seats.push(c); }
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

  /** Host confirms a validated move to everyone. */
  room.sendMove = (idx, by) => broadcast({ t: 'move', idx, by });

  room.start = (players) => {
    started = true;
    broadcast({ t: 'start', config, players });
  };

  room.restart = (players) => broadcast({ t: 'restart', config, players });

  room.destroy = () => {
    try { broadcast({ t: 'bye' }); } catch { /* ignore */ }
    setTimeout(() => { try { peer.destroy(); } catch { /* ignore */ } }, 120);
  };

  handlers.onLobby?.({ count: 1, capacity, seat: 0 });
  return room;
}

/* ------------------------------------------------------------------ client -- */

export async function joinRoom({ code, handlers }) {
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

    conn.on('open', () => {
      clearTimeout(timer);
      settled = true;
      resolve({
        code,
        isHost: false,
        peer,
        get seat() { return seat; },
        sendMove: (idx) => { if (conn.open) conn.send({ t: 'move', idx }); },
        destroy: () => { try { conn.close(); } catch { /* ignore */ } try { peer.destroy(); } catch { /* ignore */ } },
      });
    });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'lobby':
          seat = msg.you;
          handlers.onLobby?.({ count: msg.count, capacity: msg.capacity, seat });
          break;
        case 'start':   handlers.onStart?.({ ...msg, seat }); break;
        case 'restart': handlers.onRestart?.({ ...msg, seat }); break;
        case 'move':    handlers.onMove?.({ idx: msg.idx, by: msg.by }); break;
        case 'left':    handlers.onClose?.({ seat: msg.seat, mid: true }); break;
        case 'full':    handlers.onError?.(new Error('That room is already full')); break;
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
