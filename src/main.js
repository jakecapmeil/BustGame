/**
 * BUST — app controller: screens, input, turn scheduling, and the glue between
 * the engine, the renderer and the network.
 *
 * Every move — local tap, AI pick, or packet off the wire — goes through one
 * serial queue, so an incoming move can never land in the middle of a cascade
 * animation and desync the board.
 */

import {
  createGame, applyMove, isLegalMove, legalMoves, scores, winnersOf,
  openingMask, blockingStarts,
  PHASE_PLACE, PHASE_PLAY, PHASE_OVER,
} from './engine.js';
import { chooseMoveAsync, difficultyLabel, DIFFICULTY_ORDER, NEEDS_NET, warmNeural } from './ai.js';
import {
  RANKS, rankFor, rankIndexFor, progressToNext, nextRank,
  matchmake, scoreResult, recordMatch, loadProfile, saveProfile,
} from './rank.js';
import { BoardAnimator, PLAYER_COLORS, hitTest, setBoardSkin } from './render.js';
import {
  MODES, MODE_ORDER, MAX_SEATS, modeFor, buildSetup, buildPartySetup, describeSetup,
  minBoardFor,
} from './modes.js';
import { icon, paintIcons } from './icons.js';
import { sfx, unlock as unlockAudio, setEnabled as setSoundEnabled, buzz } from './audio.js';
import { hostRoom, joinRoom, normaliseCode, cleanName, MAX_PARTY } from './net.js';

/* ---------------------------------------------------------------- settings -- */

const SETTINGS_KEY = 'bust.settings.v1';
const settings = loadSettings();

function loadSettings() {
  const base = {
    sound: true, haptics: true, mode: 'duel', custom: null,
    speed: 1,        // 1x or 2x — how fast a bot thinks and a cascade plays
    name: '',        // what other players see you as online
  };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch { return base; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const haptic = (ms) => { if (settings.haptics) buzz(ms); };

/* ------------------------------------------------------------------- speed -- */

// Two gears, and nothing in between: 1x is the pace the game was tuned at, 2x
// halves the bot's thinking pause and the cascade's playback for anyone who
// already knows what a bust looks like. It is not a difficulty setting — the
// bot's search budget is untouched, only the beat it waits before committing.
const SPEEDS = [1, 2];

function gameSpeed() {
  return SPEEDS.includes(settings.speed) ? settings.speed : 1;
}

/** Push the current speed into the animator and repaint every control for it. */
function applySpeed() {
  animator.speed = gameSpeed();
  const chip = $('#toggle-speed');
  if (chip) {
    chip.textContent = `Speed ${gameSpeed()}\u00D7`;
    chip.classList.toggle('is-fast', gameSpeed() > 1);
  }
  document.querySelectorAll('#pause-speed .seg-btn').forEach((b) => {
    b.classList.toggle('is-on', Number(b.dataset.v) === gameSpeed());
  });
}

function setSpeed(v) {
  settings.speed = SPEEDS.includes(v) ? v : 1;
  saveSettings();
  applySpeed();
}

/* ------------------------------------------------------------------- modes -- */

// Up to four players get their own screen edge, rotated to face them. Beyond
// that the chips go into flat rails top and bottom — see `.is-crowded`.
// Turn order runs clockwise from the bottom edge: bottom -> left -> top -> right.
const SEAT_ORDER = {
  1: ['bottom'],
  2: ['bottom', 'top'],
  3: ['bottom', 'left', 'top'],
  4: ['bottom', 'left', 'top', 'right'],
};

/** The mode the player has selected; drives every play screen and the theme. */
let modeKey = settings.mode && MODES[settings.mode] ? settings.mode : 'duel';
let customCfg = { seats: 4, board: [9, 9], teams: null, wallDensity: 0 };
if (settings.custom) customCfg = { ...customCfg, ...settings.custom };

function currentMode() {
  return modeKey === 'custom' ? { ...modeFor('custom'), ...customCfg } : modeFor(modeKey);
}

/** Everything `createGame` needs for the selected mode, with fresh walls. */
function currentSetup(seed = Date.now()) {
  return buildSetup(modeKey, modeKey === 'custom' ? customCfg : null, seed);
}

/**
 * Repaint the whole app in the mode's palette. The board reads its colours back
 * out of the same custom properties, so canvas and DOM never drift apart.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  setBoardSkin({
    tile: v('--tile', '#F8EBDA'),
    tileDim: v('--tile-dim', '#E0C6B4'),
    wall: v('--wall', '#8B6B57'),
    wallInk: 'rgba(0,0,0,0.22)',
    shadow: 'rgba(0,0,0,0.16)',
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', v('--bg', '#D98E74'));
  if (session) refreshBoardOnly();
}

// Badge tints per rank, smallest charge → largest. The run walks from paper
// and kraft, through gunmetal and ordnance orange, into the nuclear end of the
// ladder — so the colour alone tells you roughly how far up you are.
const RANK_COLORS = {
  firecracker: '#E0543F', dynamite: '#C4862F', grenade: '#5E7A43',
  shell: '#78838F', bombshell: '#3D424E', airstrike: '#2A6E96',
  moab: '#D97B22', fatman: '#6E4FCF', hydrogen: '#1FA9B8', tsar: '#E5A82B',
};

/** @type {object} persisted trophy profile */
let profile = loadProfile();

/* --------------------------------------------------------------------- dom -- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const canvas = $('#board');
const boardArea = $('#board-area');
const shareBar = $('#share-bar');
const turnBanner = $('#turn-banner');
const turnText = $('#turn-text');
const turnDot = $('#turn-dot');
const liveRegion = $('#a11y-live');
const animator = new BoardAnimator(canvas);

/** Push a message to the screen-reader live region (deduped). */
let lastAnnounced = '';
function announce(msg) {
  if (!liveRegion || msg === lastAnnounced) return;
  lastAnnounced = msg;
  liveRegion.textContent = msg;
}

/* -------------------------------------------------------- keyboard cursor -- */

let keyCursor = -1;   // tile index the arrow-key cursor sits on
let keyActive = false; // becomes true once the player uses the keyboard

/* ------------------------------------------------------------------ screens -- */

let currentScreen = 'screen-home';

function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
  currentScreen = id;
  if (id === 'screen-game') requestAnimationFrame(fitBoard);
  if (id === 'screen-home') renderHomeStrip();
  if (id === 'screen-ranked') renderRankedScreen();
  requestAnimationFrame(syncScrollFades);
}

/**
 * A scroller wears its fade-out mask only while there is genuinely more below
 * it. Applied unconditionally, every short screen faded its own last row into
 * the background — which reads as a rendering fault, not as a hint.
 */
function syncScrollFades() {
  $$('.scroller').forEach((el) => {
    const over = el.scrollHeight - el.clientHeight;
    el.classList.toggle('is-clipped', over - el.scrollTop > 8);
    el.classList.toggle('is-clipped-top', el.scrollTop > 8);
    // Measured on overflow rather than on the fade, so it cannot flip as the
    // player scrolls to the end of a long screen.
    el.classList.toggle('is-short', over <= 1);
  });
}

function closeOverlays() {
  $('#overlay-pause').hidden = true;
  $('#overlay-out').hidden = true;
  $('#overlay-over').hidden = true;
}

/* ----------------------------------------------------------------- session -- */

/** @type {null | object} */
let session = null;
let epoch = 0; // bumped on every new/abandoned game to void stale async work

function playerLabel(p) {
  return p.name;
}

/**
 * @param {object} opts
 * @param {'solo'|'local'|'online'|'ranked'} opts.mode
 * @param {number} opts.cols @param {number} opts.rows
 * @param {Array} opts.players
 * @param {number} [opts.localSeat] which player this device controls (online)
 * @param {object} [opts.room] net room handle (online)
 * @param {number[]} [opts.ratings] trophy-equivalent rating per player id (ranked)
 * @param {boolean} [opts.bounce]   walls hand a bust its balls back
 */
function startGame({
  mode, cols, rows, players, localSeat = 0, room = null, ratings = null,
  teams = null, blocked = null, bounce = false, modeKey: mk = modeKey,
}) {
  epoch++;
  animator.cancel();
  closeOverlays();

  session = {
    mode,
    modeKey: mk,
    room,
    localSeat,
    ratings,
    elimTurn: {},   // pid -> state.turnNumber it was knocked out on
    state: createGame({ cols, rows, players, teams, blocked, bounce }),
    queue: [],
    pumping: false,
    aiTimer: 0,
    over: false,
    outShown: false,   // the "you lose" card has had its one chance to appear
    spectating: false, // knocked out, chose to watch the rest
    planned: null,     // tile this device will play the moment its turn comes
    pending: null,     // online: a move proposed to the host, not yet echoed
    pendingTimer: 0,
  };

  keyCursor = Math.floor((rows * cols) / 2);
  keyActive = false;
  lastTap = null;
  lastAnnounced = '';
  applySpeed();

  buildSeats();
  show('screen-game');
  fitBoard();
  refresh();
  scheduleAI();
}

/** Players this device is allowed to move for. */
function controlsPlayer(pid) {
  if (!session) return false;
  const p = session.state.players[pid];
  if (!p || p.kind === 'ai') return false;
  if (session.mode === 'online') return pid === session.localSeat;
  return true; // solo (human is the only human) and pass-and-play
}

/* -------------------------------------------------------------------- seats -- */

function chipHtml(state, pid) {
  const team = state.teams ? ` <span class="who">T${state.teams[pid] + 1}</span>` : '';
  // Names are hidden on the flat rails (there is no room for eight of them), so
  // the seat this device plays carries a marker instead — otherwise a rail of
  // identical pills gives you no way to find your own score.
  // Pass-and-play controls every seat, so "YOU" there would be on all of them
  // and say nothing. It only earns its place when one seat is yours.
  // ...unless the seat's name already says it. In solo and ranked the local
  // player is literally called "You", and "YOU You" is nobody's idea of a chip.
  const mine = mySeats().length === 1 && controlsPlayer(pid);
  const you = mine && state.players[pid].name !== 'You' ? '<span class="me">YOU</span>' : '';
  return `
    <div class="score-chip" data-pid="${pid}">
      <span class="dot" style="background:${PLAYER_COLORS[pid].ball}"></span>
      <span class="val num">0</span>${you}
      <span class="who">${escapeHtml(playerLabel(state.players[pid]))}</span>${team}
    </div>`;
}

function buildSeats() {
  const { state, localSeat } = session;
  const n = state.players.length;
  const screen = $('#screen-game');

  $$('.seat').forEach((el) => { el.classList.remove('is-shown'); el.innerHTML = ''; });

  // Rotated edge seats exist so a phone on a table reads right-way-up for
  // everyone — that only matters when the device is actually being passed
  // around. Everywhere else (and always past four players) the chips go into
  // flat rails, which hands the board back the ~25% of width the side columns
  // would have eaten.
  // Rotated edge seats exist for a device that is physically turned round a
  // table, so they need touch AND enough screen to spend on them. On a desktop
  // nobody rotates the monitor and upside-down names are simply wrong; on a
  // phone the two side columns cost the board a quarter of its width, which on
  // a 390px screen shrank it from 366px to 277px and left half the display
  // empty. A tablet has the room and loses about a tenth — there it is worth it.
  const roomy = typeof matchMedia === 'function'
    ? matchMedia('(pointer: coarse) and (min-width: 700px) and (min-height: 620px)').matches
    : false;
  const crowded = n > 4 || session.mode !== 'local' || !roomy;
  screen.classList.toggle('is-crowded', crowded);
  // Reading order: you first, then round the table. Both layouts use it — the
  // gauge under the board is the same gauge whichever way the chips are turned.
  const rot = (pid) => (pid - localSeat + n) % n;
  const ordered = [...state.players].sort((a, b) => rot(a.id) - rot(b.id)).map((p) => p.id);
  // Names are dropped from the flat rails because eight of them do not fit —
  // but four do, and in an online party the names are the whole point of
  // having asked for them.
  screen.classList.toggle('is-few', n <= 4);

  if (crowded) {
    // Both rails now sit hard against the board rather than at the screen's
    // edges, so the split is simply "you and your near neighbours below, the
    // rest above" — the clockwise corner loop it used to describe no longer
    // exists to describe.
    const half = Math.ceil(n / 2);
    const rails = { bottom: ordered.slice(0, half), top: ordered.slice(half).reverse() };
    for (const [slot, ids] of Object.entries(rails)) {
      const el = document.querySelector(`.seat-${slot}`);
      if (!el || !ids.length) continue;
      el.classList.add('is-shown');
      el.innerHTML = ids.map((pid) => chipHtml(state, pid)).join('');
    }
    buildShareBar(ordered);
    return;
  }

  buildShareBar(ordered);
  const order = SEAT_ORDER[n] || SEAT_ORDER[4];
  for (let pid = 0; pid < n; pid++) {
    // Rotate so the device's own player always sits at the bottom edge.
    const slot = order[(pid - localSeat + n) % n];
    const el = document.querySelector(`.seat-${slot}`);
    if (!el) continue;
    el.classList.add('is-shown');
    el.innerHTML = chipHtml(state, pid);
  }
}

/* -------------------------------------------------------------- share bar -- */

/**
 * One stacked rail under the board showing how much of it each seat holds.
 * Segments are laid out in the same order the chips read in, and whatever is
 * left over is unclaimed board — so the bar also shows how much game is left.
 */
function buildShareBar(ordered) {
  shareBar.innerHTML = ordered.map((pid) => (
    `<i data-pid="${pid}" style="background:${PLAYER_COLORS[pid].ball}"`
    + `${mySeats().length === 1 && controlsPlayer(pid) ? ' class="mine"' : ''}></i>`
  )).join('');
  shareBar.classList.add('is-shown');
}

function refreshShareBar(tiles) {
  if (!shareBar.classList.contains('is-shown')) return;
  const total = session.state.owner.length - countWalls(session.state);
  for (const seg of shareBar.children) {
    const pid = Number(seg.dataset.pid);
    seg.style.width = `${total ? (tiles[pid] / total) * 100 : 0}%`;
    seg.style.opacity = session.state.players[pid].alive ? '1' : '.35';
  }
}

function countWalls(state) {
  if (!state.blocked) return 0;
  let n = 0;
  for (let i = 0; i < state.blocked.length; i++) if (state.blocked[i]) n++;
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------ display -- */

/**
 * Size the canvas to the board.
 *
 * In the rotated-seat layout the board area is a grid cell and the canvas
 * simply fills it — the side columns have a fixed width in CSS, so whatever the
 * area reports is already clear of them.
 *
 * The crowded layout is a centred flex column (rail, board, share bar, rail),
 * which means the board area has to shrink-wrap the board: if the canvas kept
 * filling the free space, the rails would be pushed back out to the screen
 * edges and the HUD would stop being one object again. So we measure what is
 * left after everything else in the column, lay the board out inside that, then
 * cut the canvas down to the board's own height plus a margin for the tile
 * shadows. On a phone the width is the binding constraint, so the second
 * layout pass lands on the same tile size as the first.
 */
function fitBoard() {
  if (!session) return;
  const { cols, rows } = session.state;
  const screen = $('#screen-game');

  const crowded = screen.classList.contains('is-crowded');
  const cs = getComputedStyle(screen);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const gapY = parseFloat(cs.rowGap) || 0;
  const gapX = parseFloat(cs.columnGap) || gapY;

  // Which siblings cost the board height and which cost it width depends on the
  // arrangement, and there are three. A phone on its side turns the crowded
  // column through ninety degrees — rails beside the board rather than above
  // and below it — and that is the only case where a crowded screen lays itself
  // out as a grid, so the computed display tells the two apart.
  const sideways = crowded && cs.display === 'grid';
  const isSideRail = (el) => (sideways
    ? el.classList.contains('seat-top') || el.classList.contains('seat-bottom')
    : !crowded && (el.classList.contains('seat-left') || el.classList.contains('seat-right')));

  // Everything that is not the board: the rails, the share bar, and (when it is
  // in flow) the turn banner. Absolutely-positioned chrome and hidden rails
  // cost nothing.
  let taken = 0;
  let stacked = 0;
  let sides = 0;
  for (const el of screen.children) {
    if (el === boardArea || el.offsetParent === null) continue;
    if (getComputedStyle(el).position === 'absolute') continue;
    if (isSideRail(el)) { sides += el.offsetWidth + gapX; continue; }
    taken += el.offsetHeight;
    stacked++;
  }

  const availW = Math.max(80, screen.clientWidth - padX - sides);
  const availH = Math.max(80, screen.clientHeight - padY - taken - gapY * stacked);

  const probe = animator.resize(availW, availH, cols, rows);
  // Enough margin to clear the tile drop shadows, and at least the padding
  // `computeLayout` will subtract again on the second pass.
  const margin = Math.max(10, Math.min(availW, availH) * 0.026);
  // Shrink-wrap the canvas to the board on BOTH axes. Whichever axis is not
  // the binding one leaves the canvas full of slack, and the chips sit against
  // the canvas — so that slack is exactly how far the score rails get thrown
  // from the board they describe. In portrait width binds and the spare height
  // is small; on a phone held sideways height binds and the spare width is
  // enormous, which put a player's own score at the far edge of the screen.
  const wrapW = Math.min(availW, probe.boardW + margin * 2);
  const wrapH = Math.min(availH, probe.boardH + margin * 2);
  const L = (Math.abs(wrapW - availW) > 1 || Math.abs(wrapH - availH) > 1)
    ? animator.resize(wrapW, wrapH, cols, rows) : probe;

  // The share bar describes the board, so it is exactly as wide as the board.
  shareBar.style.width = `${Math.round(L.boardW)}px`;
  boardArea.style.height = `${Math.round(wrapH)}px`;

  refreshBoardOnly();
}

function chrome() {
  const s = session.state;
  // Nothing is greyed out during the opening round. Shading two thirds of the
  // board before anyone has touched it read as damage rather than as a rule;
  // the legal tiles already pulse, and a collision now announces itself when
  // you actually cause one (see `showMaskClash`).
  const view = { walls: s.blocked, teams: s.teams };
  if (session.planned !== null) view.planned = session.planned;
  if (s.phase !== PHASE_OVER && controlsPlayer(s.turn)) {
    view.legal = new Set(legalMoves(s));
    if (keyActive && keyCursor >= 0) view.cursor = keyCursor;
  }
  return view;
}

function refreshBoardOnly() {
  const s = session.state;
  animator.setView({ owner: s.owner, count: s.count, ...chrome() });
  animator.startIdle();
}

function refresh() {
  const s = session.state;
  const { tiles } = scores(s);

  $$('.score-chip').forEach((chip) => {
    const pid = Number(chip.dataset.pid);
    chip.querySelector('.val').textContent = tiles[pid];
    chip.classList.toggle('is-turn', s.phase !== PHASE_OVER && s.turn === pid);
    chip.classList.toggle('is-out', !s.players[pid].alive);
  });
  refreshShareBar(tiles);

  turnText.textContent = bannerText();
  // The pill itself is cream and stays cream; the seat's colour is the dot.
  turnDot.style.background = s.phase === PHASE_OVER
    ? 'var(--ink-dim)'
    : PLAYER_COLORS[s.turn].ball;

  if (s.phase !== PHASE_OVER) {
    const you = tiles.map((t, pid) => `${playerLabel(s.players[pid])} ${t}`).join(', ');
    announce(`${bannerText()}. Tiles: ${you}.`);
  }

  refreshBoardOnly();
}

function bannerText() {
  const s = session.state;
  if (s.phase === PHASE_OVER) return 'Game over';
  // A planned move is the one thing you want confirmed while you wait, and the
  // banner is already the "what is happening" line.
  if (movePending()) return 'Move sent…';
  if (session.planned !== null && !controlsPlayer(s.turn)) return 'Move planned · tap to undo';
  if (session.spectating) return `Spectating · ${playerLabel(s.players[s.turn])}`;
  const p = s.players[s.turn];
  const mine = controlsPlayer(s.turn);
  if (s.phase === PHASE_PLACE) {
    return mine ? 'Pick your opening tile' : `${playerLabel(p)} is opening`;
  }
  if (p.kind === 'ai') return `${playerLabel(p)} is thinking…`;
  if (session.mode === 'solo' || session.mode === 'ranked') return 'Your turn';
  return mine && session.mode === 'online' ? 'Your turn' : `${playerLabel(p)}'s turn`;
}

/* -------------------------------------------------------------- move queue -- */

/**
 * All moves funnel through here. `source` is 'local' (this device acted),
 * 'ai', or 'net' (already validated and echoed by the host).
 */
function enqueue(idx, source, from) {
  if (!session || session.over) return;
  session.queue.push({ idx, source, from });
  pump();
}

async function pump() {
  if (!session || session.pumping) return;
  session.pumping = true;
  const myEpoch = epoch;

  try {
    while (session && epoch === myEpoch && session.queue.length) {
      const { idx, source, from } = session.queue.shift();
      const s = session.state;

      // Host referees: an illegal or out-of-turn packet is simply dropped, and
      // because clients only apply on echo they stay in step automatically.
      //
      // Both checks happen *here*, against the board the move would actually
      // land on, rather than when the packet arrived. A client that plays the
      // instant its own animation ends can beat the host's animation to the
      // punch, and judging it against the host's mid-cascade turn threw away a
      // perfectly legal move — which is most of what made online feel flaky.
      if (source === 'net' && session.room?.isHost) {
        if (from !== undefined && s.turn !== from) continue;
        if (!isLegalMove(s, idx)) continue;
      } else if (source !== 'net' && !isLegalMove(s, idx)) {
        continue;
      }

      const r = applyMove(s, idx);
      if (!r.ok) continue;

      // Broadcast before animating so remote players aren't waiting on our frames.
      if (session.room?.isHost) session.room.sendMove(idx, s.turn);

      await animateMove(r.frames);
      if (!session || epoch !== myEpoch) return;

      // Note when each player was knocked out — the trophy scorer weighs how
      // long you lasted.
      for (const p of r.state.players) {
        if (!p.alive && session.elimTurn[p.id] === undefined) {
          session.elimTurn[p.id] = r.state.turnNumber;
        }
      }

      session.state = r.state;
      session.pending = null;   // whatever we were waiting on has landed
      refresh();

      if (r.state.phase === PHASE_OVER) { finish(); return; }
      // Knocked out with the board still live: stop here and let them choose.
      // Not scheduling the next bot is what holds the game behind the card.
      if (offerSpectate()) return;
      scheduleAI();
    }
  } finally {
    if (session && epoch === myEpoch) session.pumping = false;
  }
  // Only once the queue has actually drained: `canActNow` refuses while the
  // pump is running, so a plan judged from inside the loop could never fire.
  if (session && epoch === myEpoch) flushPlan();
}

async function animateMove(frames) {
  let bustCount = 0;
  await animator.play(frames, chrome(), (evt) => {
    if (evt.type === 'open') { sfx.open(); haptic(18); }
    else if (evt.type === 'place') { sfx.place(); haptic(9); }
    else if (evt.type === 'wave') {
      sfx.bust(bustCount, evt.busts.length);
      haptic(Math.min(30, 10 + evt.busts.length * 4));
      bustCount++;
    }
  });
}

/* ----------------------------------------------------------------- AI turns -- */

// How long a bot pauses before it plays, at 1x. Openings get a little longer,
// because a placement changes the map more than a single ball does. The speed
// setting divides both — see `gameSpeed`.
const AI_THINK = 550;
const AI_THINK_OPEN = 650;

function scheduleAI() {
  if (!session || session.over) return;
  const s = session.state;
  if (s.phase === PHASE_OVER) return;
  const p = s.players[s.turn];
  if (p.kind !== 'ai') return;
  // Online games are driven by the host only; there are no bots there anyway.
  if (session.mode === 'online' && !session.room?.isHost) return;

  clearTimeout(session.aiTimer);
  const myEpoch = epoch;
  // A real beat of "thinking" before a bot commits. Long enough that a table of
  // bots reads as a sequence of decisions you can follow rather than a blur —
  // this is the single biggest lever on how fast the game *feels*.
  session.aiTimer = setTimeout(() => {
    if (!session || epoch !== myEpoch) return;
    // The neural rung has to fetch its weights the first time, so the choice is
    // a promise. Every other rung resolves in the same tick. Re-check that the
    // board is still the one we asked about before committing the move: a
    // restart, or the player leaving the screen, can land while we wait.
    const asked = session.state;
    Promise.resolve(chooseMoveAsync(asked, p.difficulty)).then((move) => {
      if (!session || epoch !== myEpoch || session.state !== asked) return;
      if (move === null || move === undefined) return;
      enqueue(move, 'ai');
    });
  }, (s.phase === PHASE_PLACE ? AI_THINK_OPEN : AI_THINK) / gameSpeed());
}

/* -------------------------------------------------------------------- input -- */

// How long a client waits on the host to echo its move before letting go of the
// turn. Long enough to cover a bad connection, short enough that a packet the
// host dropped never locks the player out of their own turn.
const PENDING_MS = 5000;

/** True when this device may act on the current turn right now. */
function canActNow() {
  if (!session || session.over) return false;
  const s = session.state;
  if (s.phase === PHASE_OVER) return false;
  if (!controlsPlayer(s.turn)) return false;
  if (session.queue.length || session.pumping) return false; // mid-cascade
  if (movePending()) return false;                           // already sent one
  return true;
}

/** A proposed move still waiting on the host, within its patience window. */
function movePending() {
  const p = session && session.pending;
  return !!p && performance.now() - p.at < PENDING_MS;
}

/**
 * Show why an opening was refused: the seated player's 3x3 zone you ran into,
 * filled red, with the zone you reached for outlined on top of it. Returns
 * false when the tile was illegal for some other reason (taking it would strand
 * a player still to open), where there is no zone to point at.
 */
function showMaskClash(idx) {
  const s = session.state;
  const clashes = blockingStarts(s, idx);
  if (!clashes.length) return false;
  const tiles = new Map();
  for (const t of openingMask(s, idx)) tiles.set(t, 'own');
  // The clash wins wherever the two zones overlap — that overlap is the reason.
  for (const c of clashes) for (const t of openingMask(s, c.at)) tiles.set(t, 'clash');
  animator.flashMasks(tiles);
  announce(`That overlaps ${clashes.map((c) => playerLabel(s.players[c.pid])).join(' and ')}'s opening.`);
  return true;
}

/** Send a chosen tile through the same path a tap would take. */
function commitTile(idx) {
  const s = session.state;
  if (!isLegalMove(s, idx)) {
    if (s.phase === PHASE_PLACE) showMaskClash(idx);
    sfx.deny(); haptic(26);
    return;
  }
  if (session.mode === 'online' && !session.room?.isHost) {
    // Clients propose; they apply only when the host echoes it back. Until it
    // does, the turn is spoken for: without that, a tap on a slow connection
    // reads as "nothing happened", gets repeated, and sends a second move for
    // the same turn. The host drops the extra, so the board was never at risk —
    // but the player was left tapping at a board that would not answer.
    session.pending = { idx, at: performance.now() };
    session.room.sendMove(idx);
    refresh();
    // Nothing else would repaint if the host simply never answers, so the
    // "sent" banner would outlive the wait it describes.
    const myEpoch = epoch;
    clearTimeout(session.pendingTimer);
    session.pendingTimer = setTimeout(() => {
      if (!session || epoch !== myEpoch || !session.pending) return;
      session.pending = null;
      refresh();
    }, PENDING_MS + 40);
    return;
  }
  enqueue(idx, 'local');
}

/* --------------------------------------------------------- planned moves -- */

// Most of a four-way game is spent watching other people think. A planned move
// turns that dead time into the turn itself: pick the tile now, and it plays
// the instant the turn comes round.
//
// Double-tap to plan rather than single-tap, because a single tap on the board
// while you wait is far more often a misfire than an intention. Undoing is a
// single tap on the planned tile — by then the dashed ring has told you the
// tile is armed, so there is nothing to guard against.
const DOUBLE_TAP_MS = 420;
let lastTap = null;   // { idx, at } — the tap a double-tap would complete

/**
 * Can this device plan a move on `idx` right now?
 *
 * Only where one seat is yours: in pass-and-play every seat is, so there is
 * never a wait to plan through, and a "plan" would just be a move played early.
 */
function canPlan(idx) {
  if (!session || session.over || session.spectating) return false;
  const s = session.state;
  if (s.phase !== PHASE_PLAY) return false;      // an opening is picked, not queued
  const seats = mySeats();
  if (seats.length !== 1) return false;
  return s.owner[idx] === seats[0];
}

function setPlan(idx) {
  session.planned = idx;
  sfx.place(); haptic(14);
  // `refresh` announces the banner, so the spoken word goes last or it is the
  // one that gets overwritten.
  refresh();
  announce('Move planned. It plays as soon as your turn comes round.');
}

function clearPlan(say = 'Planned move cleared.') {
  if (!session || session.planned === null) return;
  session.planned = null;
  if (session.state) refresh();
  if (say) announce(say);
}

/** A tap on the board while this device cannot move: plan, or undo a plan. */
function planTap(idx) {
  if (session.planned === idx) { sfx.ui(); haptic(8); clearPlan(); lastTap = null; return; }
  if (!canPlan(idx)) { lastTap = null; return; }
  const now = performance.now();
  if (lastTap && lastTap.idx === idx && now - lastTap.at < DOUBLE_TAP_MS) {
    lastTap = null;
    setPlan(idx);
    return;
  }
  lastTap = { idx, at: now };
}

/**
 * Play the planned move the moment it becomes playable. Called after every
 * move settles, so a plan fires on the turn it was made for and never sits
 * around waiting for a tap.
 */
function flushPlan() {
  if (!session || session.planned === null) return;
  const idx = session.planned;
  if (!canActNow()) return;
  // The tile can have been taken while the plan sat waiting — say so rather
  // than letting the ring quietly vanish.
  if (!isLegalMove(session.state, idx)) {
    clearPlan('Your planned tile is gone — pick another.');
    return;
  }
  session.planned = null;
  announce('Playing your planned move.');
  commitTile(idx);
}

function onBoardPointer(ev) {
  unlockAudio();
  // The board can still be on screen for a beat after a session is torn down
  // (a dropped connection, say), and planning would reach straight into it.
  if (!session || !animator.L) return;
  const rect = canvas.getBoundingClientRect();
  const pt = ev.changedTouches ? ev.changedTouches[0] : ev;
  const idx = hitTest(animator.L, pt.clientX - rect.left, pt.clientY - rect.top);
  if (idx < 0) return;
  keyActive = false; // a tap takes over from the keyboard cursor
  if (!canActNow()) { planTap(idx); return; }
  lastTap = null;
  // A tile you already planned is played by the plan, not by this tap — so a
  // tap on it as your turn opens undoes it rather than playing it twice.
  if (session.planned === idx) { sfx.ui(); haptic(8); clearPlan(); return; }
  commitTile(idx);
}

function onBoardKey(ev) {
  if (!session || session.over || !session.state) return;
  const s = session.state;
  const { cols, rows } = s;
  const n = cols * rows;
  if (keyCursor < 0 || keyCursor >= n) keyCursor = Math.floor(n / 2);

  let dx = 0;
  let dy = 0;
  switch (ev.key) {
    case 'ArrowLeft': case 'a': dx = -1; break;
    case 'ArrowRight': case 'd': dx = 1; break;
    case 'ArrowUp': case 'w': dy = -1; break;
    case 'ArrowDown': case 's': dy = 1; break;
    case 'Enter': case ' ': case 'Spacebar':
      ev.preventDefault();
      unlockAudio();
      if (canActNow()) commitTile(keyCursor);
      else if (session.planned === keyCursor) { sfx.ui(); clearPlan(); }
      else if (canPlan(keyCursor)) setPlan(keyCursor);
      return;
    default: return;
  }
  ev.preventDefault();
  keyActive = true;
  const cx = Math.min(cols - 1, Math.max(0, (keyCursor % cols) + dx));
  const cy = Math.min(rows - 1, Math.max(0, ((keyCursor / cols) | 0) + dy));
  keyCursor = cy * cols + cx;
  const owner = s.owner[keyCursor];
  const who = owner === -1 ? 'empty' : `${PLAYER_COLORS[owner].name}, ${s.count[keyCursor]}`;
  announce(`Cursor on column ${cx + 1}, row ${cy + 1}: ${who}.`);
  refreshBoardOnly();
}

canvas.addEventListener('pointerup', onBoardPointer);
canvas.addEventListener('keydown', onBoardKey);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------------------------------------------------- knocked out -- */

/** Seats this device is playing. Pass-and-play holds several. */
function mySeats() {
  const s = session.state;
  if (session.mode === 'online') return [session.localSeat];
  return s.players.filter((p) => p.kind !== 'ai').map((p) => p.id);
}

/**
 * Raise the "you lose" card when every seat this device plays is out but the
 * board is still live — in a four-way brawl that can happen twenty moves before
 * anyone wins, and until now the game simply carried on without you.
 *
 * Returns true if the card went up, which is the caller's signal to stop
 * scheduling turns until Spectate or Exit is pressed.
 */
function offerSpectate() {
  if (!session || session.outShown || session.spectating) return false;
  const s = session.state;
  if (s.phase !== PHASE_PLAY) return false;
  const seats = mySeats();
  if (!seats.length || seats.some((pid) => s.players[pid].alive)) return false;

  session.outShown = true;
  const dead = seats[seats.length - 1];
  $('#out-disc').style.background = PLAYER_COLORS[dead].ball;

  const alive = s.players.filter((p) => p.alive);
  const lasted = Math.max(...seats.map((pid) => session.elimTurn[pid] || s.turnNumber));
  $('#out-sub').textContent = seats.length > 1
    ? `Every seat is out after ${lasted} moves. ${alive.length} bots left standing.`
    : `Wiped out on move ${lasted}. ${alive.length} still standing.`;

  $('#overlay-out').hidden = false;
  sfx.lose();
  haptic(60);
  announce(`You lose. ${$('#out-sub').textContent}`);
  return true;
}

/** Stay and watch. The board runs to a finish; the result card still shows. */
function spectate() {
  if (!session) return;
  session.spectating = true;
  $('#overlay-out').hidden = true;
  refresh();
  scheduleAI();
}

/* ------------------------------------------------------------------ ending -- */

function finish() {
  if (!session || session.over) return;
  session.over = true;
  const s = session.state;
  const w = s.winner;
  const won = controlsPlayer(w)
    || (session.mode === 'local' && winnersOf(s).some((pid) => s.players[pid].kind !== 'ai'));

  const winners = winnersOf(s);
  const teamEl = $('#over-team');
  if (winners.length > 1) {
    // A team win: show every colour on the winning side, not one disc.
    $('#over-disc').classList.add('is-hidden');
    teamEl.classList.remove('is-hidden');
    teamEl.innerHTML = winners
      .map((pid) => `<span class="dot" style="background:${PLAYER_COLORS[pid].ball}"></span>`).join('');
  } else {
    $('#over-disc').classList.remove('is-hidden');
    teamEl.classList.add('is-hidden');
  }
  $('#over-disc').style.background = PLAYER_COLORS[w].ball;
  const isSelf = ((session.mode === 'solo' || session.mode === 'ranked') && winners.includes(0))
    || (session.mode === 'online' && winners.includes(session.localSeat));
  $('#over-title').textContent = isSelf ? 'You win!'
    : session.mode === 'local' ? `${playerLabel(s.players[w])} wins!`
    : `${playerLabel(s.players[w])} wins`;

  const { tiles } = scores(s);
  $('#over-sub').textContent = `${tiles[w]} tiles held · ${s.turnNumber} moves`;

  const tally = session.mode === 'ranked' ? settleRanked() : null;
  $('#over-trophies').hidden = !tally;
  $('#overlay-over').hidden = false;
  // The round is over; the party is not. Reopening it lets people join or
  // leave before the next one and clears everybody's ready tick, so "play
  // again" starts from a fresh vote.
  if (session.mode === 'online' && room?.isHost) room.openParty();
  renderPartyOver();

  if (isSelf || (session.mode === 'local' && won)) sfx.win(); else sfx.lose();
  haptic(50);
  let msg = `${$('#over-title').textContent} ${$('#over-sub').textContent}`;
  if (tally) {
    msg += `. ${tally.result.delta >= 0 ? '+' : ''}${tally.result.delta} trophies, now ${tally.profile.trophies}.`;
    if (tally.promotedTo) msg += ` Promoted to ${tally.promotedTo.name}.`;
    if (tally.demotedTo) msg += ` Demoted to ${tally.demotedTo.name}.`;
  }
  announce(msg);
}

/**
 * Score the finished ranked match, persist the new trophy total, and paint the
 * tally onto the game-over card. Returns the recordMatch() bundle, or null if
 * this wasn't a scorable ranked game.
 */
function settleRanked() {
  const s = session.state;
  if (!session.ratings || s.winner === null || s.winner === undefined) return null;

  const before = profile;
  const result = scoreResult({
    state: s,
    myId: 0,
    ratings: session.ratings,
    elimTurn: session.elimTurn,
    trophies: before.trophies,
    played: before.played,
  });
  const bundle = recordMatch(before, result);
  profile = bundle.profile;
  saveProfile(profile);

  const up = result.delta >= 0;
  const dEl = $('#over-delta');
  dEl.textContent = `${up ? '+' : ''}${result.delta}`;
  // Keep `tally-delta num` — overwriting them drops the 44px tabular styling
  // that makes the delta the hero of this card.
  dEl.className = `tally-delta num ${up ? 'up' : 'down'}`;
  countTo($('#over-troph-count'), profile.trophies, 900);
  paintBadge($('#over-troph-badge'), rankFor(profile.trophies));
  $('#over-troph-fill').style.width = `${Math.round(progressToNext(profile.trophies).frac * 100)}%`;

  const jump = $('#over-rank-jump');
  if (bundle.promotedTo) {
    jump.hidden = false; jump.className = 'rank-jump promo';
    jump.textContent = `Promoted — ${bundle.promotedTo.name}`;
  } else if (bundle.demotedTo) {
    jump.hidden = false; jump.className = 'rank-jump demo';
    jump.textContent = `Demoted — ${bundle.demotedTo.name}`;
  } else {
    jump.hidden = true;
  }

  const bd = $('#over-breakdown');
  bd.innerHTML = '';
  result.breakdown.forEach((b) => {
    const li = document.createElement('li');
    const beat = b.result > b.expected;
    li.innerHTML = `<span>${escapeHtml(playerLabel(s.players[b.oppId]))} · ${Math.round(b.oppRating)}`
      + `${icon('trophy', 'ico-inline')}</span>`
      + `<span>${b.result === 1 ? 'beat' : b.result === 0 ? 'lost to' : 'tied'}`
      + `${beat ? icon('rise', 'ico-inline') : ''}</span>`;
    bd.appendChild(li);
  });
  return bundle;
}

/* ------------------------------------------------------------------ ranked -- */

/** A rank badge: the rank's own bomb, on the rank's own tint. */
function paintBadge(el, rank) {
  if (!el) return;
  el.innerHTML = icon(rank.key);
  el.style.background = RANK_COLORS[rank.key] || '#8A5A3C';
  el.setAttribute('aria-hidden', 'true');
}

/**
 * Roll a number up or down instead of snapping it. Cheap, self-cancelling, and
 * a no-op under `prefers-reduced-motion`.
 */
const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

function countTo(el, to, ms = 700) {
  if (!el) return;
  const from = Number(el.textContent.replace(/[^0-9-]/g, '')) || 0;
  if (REDUCED || from === to) { el.textContent = to; return; }
  clearInterval(el._ticker);
  const t0 = performance.now();
  el._ticker = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (k >= 1) clearInterval(el._ticker);
  }, 16);
}

/** The persistent trophy pill on the home screen. */
function renderHomeStrip() {
  const strip = $('#rank-strip');
  if (!strip) return;
  strip.hidden = false; // always show it — 0 trophies is a valid start
  const rank = rankFor(profile.trophies);
  paintBadge($('#strip-badge'), rank);
  $('#strip-name').textContent = rank.name;
  countTo($('#strip-count'), profile.trophies);
  const prog = progressToNext(profile.trophies);
  $('#strip-fill').style.width = `${Math.round(prog.frac * 100)}%`;
  // An empty meter with no caption reads as a broken loading bar, which is
  // exactly what a brand-new player sees on their very first screen.
  const nxt = nextRank(profile.trophies);
  $('#strip-next').textContent = nxt ? `${prog.need - prog.have} to ${nxt.name}` : 'Top rank';
  paintModeHero('hero', currentMode());
}

function renderRankedScreen() {
  const rank = rankFor(profile.trophies);
  paintBadge($('#rank-hero-badge'), rank);
  $('#rank-hero-name').textContent = rank.name;
  countTo($('#rank-hero-count'), profile.trophies);
  const prog = progressToNext(profile.trophies);
  $('#rank-hero-fill').style.width = `${Math.round(prog.frac * 100)}%`;
  const nxt = nextRank(profile.trophies);
  $('#rank-hero-next').textContent = nxt
    ? `${prog.need - prog.have} to ${nxt.name}`
    : 'Top rank reached';

  $('#stat-played').textContent = profile.played;
  $('#stat-rate').textContent = profile.played
    ? `${Math.round((profile.won / profile.played) * 100)}%` : '—';
  $('#stat-best').textContent = profile.best;

  const mode = currentMode();
  paintModeHero('ranked-hero', mode, `${describeSetup(mode, true)} · ${rank.pool.map(difficultyLabel).join('/')} bots`);

  const here = rankIndexFor(profile.trophies);
  const list = $('#ladder-list');
  list.innerHTML = '';
  // Top rank at the top: the ladder is something you climb, so it has to run
  // upward. Rendered in reverse rather than flipped with `column-reverse`, so
  // the DOM order a screen reader walks matches the order on screen.
  let hereEl = null;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    const r = RANKS[i];
    const li = document.createElement('li');
    if (i === here) { li.classList.add('is-here'); hereEl = li; }
    if (i > here) li.classList.add('is-locked');
    const badge = document.createElement('span');
    badge.className = 'rank-badge';
    paintBadge(badge, r);
    li.appendChild(badge);
    const name = document.createElement('span');
    name.textContent = r.name;
    li.appendChild(name);
    const min = document.createElement('span');
    min.className = 'lad-min';
    min.innerHTML = `${r.min}${icon('trophy', 'ico-inline')}`;
    li.appendChild(min);
    list.appendChild(li);
  }

  // Ten ranks do not fit on a phone, and the one that matters is your own — so
  // open the ladder on it rather than at the top of the run. The LADDER is what
  // scrolls, not the screen: scrolling the screen took the hero with it, and
  // the hero is what you opened this screen to read.
  //
  // Driven off scrollTop rather than scrollIntoView, which will happily scroll
  // an ancestor instead. Measured synchronously — the rows are in the DOM, and
  // a rAF here would never fire on a hidden tab. Instant, not smooth: the
  // ladder should simply already be on your rank when the screen opens.
  if (hereEl) {
    const delta = hereEl.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const want = list.scrollTop + delta - list.clientHeight / 2 + hereEl.offsetHeight / 2;
    list.scrollTop = Math.max(0, want);
  }
}

/**
 * The mode decides the shape of the match, the rank decides how hard the bots
 * play — so you climb one ladder whichever mode you prefer.
 */
function startRankedMatch() {
  const setup = currentSetup();
  const m = matchmake(profile.trophies, setup.seats);
  startGame({
    mode: 'ranked',
    cols: setup.cols, rows: setup.rows,
    teams: setup.teams, blocked: setup.blocked, bounce: setup.bounce,
    players: m.players,
    ratings: m.ratings,
  });
}

$('#ranked-play').addEventListener('click', () => {
  unlockAudio(); sfx.ui(); haptic(8);
  startRankedMatch();
});

/* --------------------------------------------------------------- restarting -- */

function restartGame() {
  if (!session) return;
  // "Play again" in ranked means a fresh matchmade opponent, not a rematch.
  if (session.mode === 'ranked') { startRankedMatch(); return; }
  // Online, a rematch is the party's decision rather than one player's.
  if (session.mode === 'online') { partyPlayAgain(); return; }

  const { mode, state, localSeat } = session;
  const players = state.players.map((p) => ({ name: p.name, kind: p.kind, difficulty: p.difficulty }));
  // Deal a fresh map rather than replaying the one just learned — a walled
  // mode is a map, and a rematch on the identical maze is a different game.
  // Only when the table still fits, though: the mode cannot change mid-game,
  // but a defensive mismatch would silently drop or duplicate a seat.
  const setup = currentSetup();
  const fits = setup.seats === players.length;
  startGame({
    mode, localSeat, players,
    cols: fits ? setup.cols : state.cols,
    rows: fits ? setup.rows : state.rows,
    teams: fits ? setup.teams : state.teams,
    blocked: fits ? setup.blocked : state.blocked,
    bounce: fits ? setup.bounce : state.bounce,
  });
}

function quitToMenu() {
  epoch++;
  animator.cancel();
  if (session?.room) teardownRoom();
  if (session) clearTimeout(session.aiTimer);
  session = null;
  closeOverlays();
  partyReturn = '';
  applyTheme(MODES[modeKey].theme);
  renderModeGrid();
  syncRosterToMode();
  refreshShapeLines();
  show('screen-home');
}

/* ----------------------------------------------------------------- overlays -- */

/** Every in-game overlay button. None of these were bound before. */
const tap = (sel, fn) => $(sel)?.addEventListener('click', () => {
  unlockAudio(); sfx.ui(); haptic(8);
  fn();
});

tap('#btn-pause', () => {
  if (!session || session.over) return;
  // An online round keeps running for everyone else, so this pauses nothing —
  // but it is still the way out, and it used to quit on the first tap with no
  // confirmation at all. Restarting alone is not one player's call there.
  const online = session.mode === 'online';
  $('#pause-restart').classList.toggle('is-hidden', online);
  $('#pause-quit').textContent = online ? 'Leave the round' : 'Quit to menu';
  $('#overlay-pause').hidden = false;
});
tap('#pause-resume', () => { $('#overlay-pause').hidden = true; });
tap('#pause-restart', () => { $('#overlay-pause').hidden = true; restartGame(); });
tap('#pause-quit', () => {
  // Leaving an online round drops you back to the party, not out of it.
  if (session?.mode === 'online' && room) {
    if (room.isHost) room.endRound('The host left the round');
    returnToLobby();
    return;
  }
  quitToMenu();
});

tap('#out-spectate', spectate);
tap('#out-exit', () => {
  if (session?.mode === 'online' && room) { returnToLobby(); return; }
  quitToMenu();
});

tap('#over-again', restartGame);
tap('#over-map', () => openMapPicker('over'));
tap('#over-menu', () => {
  if (session?.mode === 'online' && room) { returnToLobby(); return; }
  quitToMenu();
});

/* ----------------------------------------------------------------- segments -- */

function segValue(id) {
  const on = document.querySelector(`#${id} .seg-btn.is-on`);
  return on ? on.dataset.v : null;
}

$$('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    unlockAudio(); sfx.ui(); haptic(8);
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-on', b === btn));
    // Start the neural weights downloading the moment the rung is chosen, so
    // the fetch overlaps the rest of the menu instead of the first turn.
    if (btn.dataset.v && NEEDS_NET.has(btn.dataset.v)) warmNeural().catch(() => {});
  });
});

/* -------------------------------------------------------------- menu wiring -- */

$$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  unlockAudio(); sfx.ui(); haptic(8);
  // The mode screen is also the party's map picker; when it was opened that
  // way, Back belongs to the party rather than to the main menu.
  if (partyReturn && b.dataset.goto === 'screen-home') { closeMapPicker(); return; }
  show(b.dataset.goto);
}));

/* ------------------------------------------------------------- mode picker -- */

function paintModeHero(prefix, mode, subOverride) {
  const g = $(`#${prefix}-glyph`);
  const n = $(`#${prefix}-name`);
  const sub = $(`#${prefix}-sub`);
  if (g) g.innerHTML = icon(mode.icon);
  if (n) n.textContent = mode.name;
  // No tagline here. The hero already gives the mode its name in 19px type, so
  // the second line is worth more spent on the shape of the match — and with
  // the tagline in front, the longest mode ran off the end into an ellipsis.
  if (sub) sub.textContent = subOverride || describeSetup(mode);
}

function renderModeGrid() {
  const grid = $('#mode-grid');
  grid.innerHTML = '';
  for (const key of MODE_ORDER) {
    const m = key === 'custom' ? { ...MODES.custom, ...customCfg } : MODES[key];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode-card' + (key === modeKey ? ' is-on' : '');
    b.dataset.mode = key;
    b.setAttribute('aria-pressed', String(key === modeKey));
    // Each card previews the palette it will switch the app to.
    b.dataset.theme = MODES[key].theme;
    b.innerHTML = `
      <span class="mode-glyph" aria-hidden="true">${icon(MODES[key].icon)}</span>
      <span>
        <span class="mode-card-name">${escapeHtml(MODES[key].name)}</span><br>
        <span class="mode-card-tag">${escapeHtml(MODES[key].tagline)} · ${escapeHtml(describeSetup(m, true))}</span>
      </span>
      <span class="mode-card-check" aria-hidden="true">${icon('check')}</span>`;
    grid.appendChild(b);
  }
  $('#modes-blurb').textContent = MODES[modeKey].blurb;
  $('#custom-panel').classList.toggle('is-hidden', modeKey !== 'custom');
}

function selectMode(key) {
  modeKey = key;
  settings.mode = key;
  saveSettings();
  applyTheme(MODES[key].theme);
  renderModeGrid();
  renderHomeStrip();
  syncRosterToMode();
  refreshShapeLines();
  // Custom opens a panel of settings below the picker, and on a small phone
  // that panel lands entirely behind the pinned Done bar — you tap Custom and
  // nothing appears to happen.
  if (key === 'custom') requestAnimationFrame(revealCustomPanel);
}

function revealCustomPanel() {
  const panel = $('#custom-panel');
  const scroller = panel?.closest('.scroller');
  if (!panel || !scroller) return;
  const delta = panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 12);
  syncScrollFades();
}

$('#mode-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.mode-card');
  if (!card) return;
  unlockAudio(); sfx.ui(); haptic(10);
  selectMode(card.dataset.mode);
});

$('#modes-done').addEventListener('click', () => {
  sfx.ui();
  applyTheme(MODES[modeKey].theme);
  renderModeGrid();
  syncRosterToMode();
  refreshShapeLines();
  if (partyReturn) { closeMapPicker(); return; }
  show('screen-home');
});

/* custom setup ------------------------------------------------------------- */

function readCustom() {
  const seats = Number(segValue('custom-seats')) || 4;
  const n = Number(segValue('custom-board')) || 9;
  const wallDensity = Number(segValue('custom-walls')) || 0;
  const wantTeams = segValue('custom-teams') === 'on';
  const bounceWalls = segValue('custom-bounce') === 'on';
  // Teams need an even table; seats alternate so turn order alternates sides.
  const teams = wantTeams && seats % 2 === 0
    ? Array.from({ length: seats }, (_, i) => i % 2) : null;
  customCfg = { seats, board: [n, n], teams, wallDensity, bounceWalls };
  settings.custom = customCfg;
  saveSettings();
  $('#custom-err').textContent = wantTeams && seats % 2
    ? 'Teams need an even number of seats — playing free-for-all.' : '';
  // Nothing to ask about the behaviour of walls that aren't there.
  $('#custom-bounce-wrap').classList.toggle('is-hidden', !wallDensity);
  $('#custom-bounce-note').textContent = bounceWalls
    ? 'A ball thrown into a wall bounces back and stays on the tile it left. Only the board edge still costs you material.'
    : 'A ball thrown into a wall is gone, exactly like one thrown off the edge.';
  renderModeGrid();
  refreshShapeLines();
  syncRosterToMode();
}

['custom-seats', 'custom-board', 'custom-teams', 'custom-walls', 'custom-bounce'].forEach((id) => {
  $(`#${id}`).addEventListener('click', (e) => { if (e.target.closest('.seg-btn')) readCustom(); });
});

/** Put the custom panel's controls where the saved settings say they are. */
function paintCustomPanel() {
  const on = (id, val) => document.querySelectorAll(`#${id} .seg-btn`).forEach((b) => {
    b.classList.toggle('is-on', b.dataset.v === String(val));
  });
  on('custom-seats', customCfg.seats);
  on('custom-board', customCfg.board[0]);
  on('custom-teams', customCfg.teams ? 'on' : 'off');
  on('custom-walls', customCfg.wallDensity || 0);
  on('custom-bounce', customCfg.bounceWalls ? 'on' : 'off');
  $('#custom-bounce-wrap').classList.toggle('is-hidden', !customCfg.wallDensity);
}

/* ------------------------------------------------------------- play screens -- */

/** The "here's what you're about to play" line on every play screen. */
function refreshShapeLines() {
  const m = currentMode();
  const shape = `${m.name} · ${describeSetup(m)}`;
  $('#solo-shape').textContent = `${shape}. You against ${m.seats - 1} bot${m.seats > 2 ? 's' : ''}.`;
  $('#local-shape').textContent = `${shape}. One device — fill the seats with any mix of people and bots.`;
  $('#online-shape').textContent = `${shape}. Host once, share the link, then play round after round — `
    + 'the board grows to however many turn up.';
  syncNeuralAvailability(!m.teams && !m.wallDensity);
  paintModeHero('hero', m);
}

/**
 * The Neural rung plays any number of seats, but not teams and not walls (see
 * `neuralSupports`), so it greys out in Duos and Chaos and in a Custom table
 * with either turned on. Greying it out with a reason beats letting a player
 * pick a rung that would quietly hand the seat back to Brutal.
 */
function syncNeuralAvailability(ok) {
  const btn = $('#solo-diff [data-v="neural"]');
  if (!btn) return;
  btn.disabled = !ok;
  btn.title = ok ? '' : 'Not trained for teams or walls — those seats play Brutal';
  if (!ok && btn.classList.contains('is-on')) {
    btn.classList.remove('is-on');
    $('#solo-diff [data-v="brutal"]')?.classList.add('is-on');
  }
}

$('#solo-start').addEventListener('click', () => {
  const setup = currentSetup();
  const diff = segValue('solo-diff');
  const players = Array.from({ length: setup.seats }, (_, i) => ({
    name: i === 0 ? 'You' : (setup.seats === 2 ? 'Bot' : `Bot ${i}`),
    kind: i === 0 ? 'human' : 'ai',
    difficulty: diff,
  }));
  startGame({
    mode: 'solo', cols: setup.cols, rows: setup.rows,
    teams: setup.teams, blocked: setup.blocked, bounce: setup.bounce, players,
  });
});

/* -------------------------------------------------------- local line-up -- */

// Every seat is Human or a Bot at one of the five difficulties. Mix freely:
// all humans is classic pass-and-play, all bots is a spectator match, and any
// blend in between works — the turn scheduler keys off each seat's kind.
let localRoster = [
  { kind: 'human', difficulty: 'medium' },
  { kind: 'human', difficulty: 'medium' },
];

/** The mode owns the seat count, so the roster grows and shrinks with it. */
function syncRosterToMode() {
  const n = currentMode().seats;
  while (localRoster.length < n) localRoster.push({ kind: 'ai', difficulty: 'medium' });
  localRoster.length = n;
  buildRoster();
}

function buildRoster() {
  const ul = $('#local-roster');
  if (!ul) return;
  const teams = currentMode().teams;
  ul.innerHTML = '';
  localRoster.forEach((seat, i) => {
    const li = document.createElement('li');
    li.className = 'roster-seat' + (seat.kind === 'human' ? ' is-human' : '');
    li.dataset.seat = String(i);
    // The neural rung has no team play and no walls, so those modes neither
    // offer it nor keep a seat pointed at it from before the mode changed.
    const solo = !teams && !currentMode().wallDensity;
    if (!solo && NEEDS_NET.has(seat.difficulty)) seat.difficulty = 'brutal';
    const diffBtns = DIFFICULTY_ORDER
      .filter((k) => solo || !NEEDS_NET.has(k))
      .map((k) => (
        `<button class="seg-btn${seat.difficulty === k ? ' is-on' : ''}" type="button" data-diff="${k}">${escapeHtml(difficultyLabel(k))}</button>`
      )).join('');
    const teamTag = teams ? `<span class="team-tag">Team ${teams[i] + 1}</span>` : '';
    li.innerHTML = `
      <div class="roster-main">
        <span class="dot" style="background:${PLAYER_COLORS[i].ball}"></span>
        <span class="who">${escapeHtml(PLAYER_COLORS[i].name)}</span>
        ${teamTag}
        <div class="seg kind" role="group" aria-label="Seat ${i + 1} type">
          <button class="seg-btn${seat.kind === 'human' ? ' is-on' : ''}" type="button" data-kind="human">Human</button>
          <button class="seg-btn${seat.kind === 'ai' ? ' is-on' : ''}" type="button" data-kind="ai">Bot</button>
        </div>
      </div>
      <div class="seg diff seg-tight" role="group" aria-label="Seat ${i + 1} difficulty">${diffBtns}</div>`;
    ul.appendChild(li);
  });
}

$('#local-roster').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const li = e.target.closest('.roster-seat');
  if (!li) return;
  const i = Number(li.dataset.seat);
  unlockAudio(); sfx.ui(); haptic(8);
  if (btn.dataset.kind) localRoster[i].kind = btn.dataset.kind;
  else if (btn.dataset.diff) {
    localRoster[i].difficulty = btn.dataset.diff;
    if (NEEDS_NET.has(btn.dataset.diff)) warmNeural().catch(() => {});
  }
  buildRoster();
});

$('#local-start').addEventListener('click', () => {
  const setup = currentSetup();
  const players = localRoster.slice(0, setup.seats).map((seat, i) => ({
    name: seat.kind === 'ai' ? `${PLAYER_COLORS[i].name} bot` : PLAYER_COLORS[i].name,
    kind: seat.kind,
    difficulty: seat.difficulty,
  }));
  startGame({
    mode: 'local', cols: setup.cols, rows: setup.rows,
    teams: setup.teams, blocked: setup.blocked, bounce: setup.bounce, players,
  });
});

/* ------------------------------------------------------------------- online -- */

/**
 * Online is a **party**, not a match.
 *
 * You get a group together once — names, a shareable link, a ready tick each —
 * and then play round after round out of the same room, changing the map
 * between rounds if you like. The lobby is where the party lives; the result
 * card is the same lobby wearing a different hat, because "play again" is a
 * vote the whole party casts rather than a button one person presses.
 *
 * The seat count comes from the party, not from the mode: the mode supplies
 * the map (board, teams, walls) and `buildPartySetup` grows the board to fit
 * however many people turned up.
 */

let room = null;
let lobby = { roster: [], capacity: MAX_PARTY, seat: 0, started: false };
let partyReturn = '';     // which card the map picker has to return to

function myName() {
  return cleanName(settings.name, 'Player');
}

/** One name, two inputs (setup and lobby) plus the wire — keep them in step. */
function syncNameInputs() {
  for (const sel of ['#online-name', '#lobby-name']) {
    const el = $(sel);
    if (el && document.activeElement !== el) el.value = settings.name || '';
  }
}

function setMyName(raw) {
  // Stored raw (so a half-typed name isn't fought with mid-keystroke) and
  // cleaned only on the way out to the wire, where it has to be safe.
  settings.name = String(raw || '').slice(0, 14);
  saveSettings();
  syncNameInputs();
  if (room) { try { room.setName(myName()); } catch { /* not connected */ } }
}

/** The setup this party would play right now: its mode's map, its own seats. */
function partySetup(seed = Date.now()) {
  const count = Math.max(2, Math.min(MAX_SEATS, lobby.roster.length));
  return buildPartySetup(modeKey, modeKey === 'custom' ? customCfg : null, count, seed);
}

function partySeatNames() {
  return lobby.roster.map((r, i) => ({ name: r.name || `Player ${i + 1}`, kind: 'human' }));
}

/** Join a round the host has described; the theme follows their chosen mode. */
function startOnline(config, players, seat) {
  // A packet can just about outrun the roster it was built from: connect in the
  // instant the host presses Start and you get the `start` without a seat in
  // it. Sit the round out rather than opening a board with no seat to play.
  if (!config || !Array.isArray(players) || !(seat >= 0) || seat >= players.length) {
    returnToLobby('That round started without you — you are in for the next one.');
    return;
  }
  if (config.modeKey && MODES[config.modeKey]) {
    modeKey = config.modeKey;
    applyTheme(MODES[modeKey].theme);
  }
  startGame({
    mode: 'online', cols: config.cols, rows: config.rows,
    teams: config.teams || null,
    blocked: config.blocked || null,
    bounce: !!config.bounce,
    players, localSeat: seat, room,
  });
}

const onlineErr = $('#online-err');
const lobbyMsg = $('#online-lobby-msg');

function showOnlineSetup() {
  $('#online-setup').classList.remove('is-hidden');
  $('#online-lobby').classList.add('is-hidden');
}
function showOnlineLobby() {
  $('#online-setup').classList.add('is-hidden');
  $('#online-lobby').classList.remove('is-hidden');
}

/** Am I ticked ready, according to the host's last roster? */
function iAmReady() {
  return !!lobby.roster[lobby.seat]?.ready;
}

function readyCount() {
  return lobby.roster.filter((r) => r.ready).length;
}

/** One row per player: colour, name, host mark, ready tick. */
function rosterRows(ul) {
  ul.innerHTML = '';
  lobby.roster.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = r.ready ? 'is-ready' : '';
    li.innerHTML = `<span class="dot" style="background:${PLAYER_COLORS[i % PLAYER_COLORS.length].ball}"></span>
      <span class="lobby-who">${escapeHtml(r.name || `Player ${i + 1}`)}</span>
      ${r.host ? '<span class="tag">host</span>' : ''}
      ${i === lobby.seat ? '<span class="you">you</span>' : ''}
      <span class="ready-tick" aria-hidden="true">${r.ready ? icon('check') : ''}</span>`;
    ul.appendChild(li);
  });
  if (!lobby.roster.length) {
    ul.innerHTML = '<li><span class="lobby-who">Connecting…</span></li>';
  }
}

function renderLobby() {
  if (!room || currentScreen !== 'screen-online') return;
  $('#online-room-code').textContent = room.code || '—';
  rosterRows($('#online-players'));

  const n = lobby.roster.length;
  const ready = readyCount();
  const all = n >= 2 && ready === n;

  const readyBtn = $('#online-ready');
  readyBtn.textContent = iAmReady() ? 'Ready — tap to cancel' : "I'm ready";
  readyBtn.setAttribute('aria-pressed', String(iAmReady()));
  readyBtn.classList.toggle('is-armed', iAmReady());

  const begin = $('#online-begin');
  begin.classList.toggle('is-hidden', !(room.isHost && all));

  // Only the host picks the map, so only the host is shown the control.
  const hero = $('#lobby-mode-hero');
  hero.classList.toggle('is-hidden', !room.isHost);
  if (room.isHost) {
    // Described from the mode and the head count rather than by building a
    // setup: generating a wall map to write a caption would run the whole
    // opening-round feasibility check on every roster change.
    const m = currentMode();
    const size = Math.max(m.board[0], minBoardFor(Math.max(2, n)));
    const bits = [`${size}×${size}`, `${n} player${n === 1 ? '' : 's'}`];
    if (m.teams && n % 2 === 0) bits.push('2v2');
    if (m.wallDensity) bits.push(m.bounceWalls ? 'bouncy walls' : 'walls');
    paintModeHero('lobby-hero', m, bits.join(' · '));
  }

  lobbyMsg.textContent = n < 2
    ? 'Share the code or the link — the party needs at least two of you.'
    : all
      ? (room.isHost ? 'Everyone is ready.' : 'Everyone is ready — waiting for the host.')
      : `${ready} of ${n} ready.`;
}

/** The result card, wearing the lobby's hat: who has voted to play again. */
function renderPartyOver() {
  const wrap = $('#over-party');
  const isParty = session && session.mode === 'online' && room;
  wrap.classList.toggle('is-hidden', !isParty);
  $('#over-map').classList.toggle('is-hidden', !(isParty && room.isHost));
  const again = $('#over-again');
  if (!isParty) { again.textContent = 'Play again'; again.classList.remove('is-armed'); return; }

  rosterRows($('#over-party-list'));
  const n = lobby.roster.length;
  again.textContent = iAmReady() ? `Ready · ${readyCount()}/${n}` : 'Play again';
  again.classList.toggle('is-armed', iAmReady());
}

/** Host: deal a round to whoever is in the party right now. */
function hostStartRound() {
  if (!room?.isHost) return;
  const setup = partySetup();
  const players = partySeatNames().slice(0, setup.seats);
  if (players.length < 2) return;
  const config = {
    cols: setup.cols, rows: setup.rows, modeKey,
    teams: setup.teams ? Array.from(setup.teams) : null,
    blocked: setup.blocked ? Array.from(setup.blocked) : null,
    bounce: !!setup.bounce,
  };
  room.start(config, players);
  startGame({
    mode: 'online', cols: setup.cols, rows: setup.rows,
    teams: setup.teams, blocked: setup.blocked, bounce: setup.bounce,
    players, localSeat: 0, room,
  });
}

/** Host: the whole party has voted to play again, so deal the next round. */
function maybeAutoStart() {
  if (!room?.isHost || !room.everyoneReady()) return;
  // Only from the result card — in the lobby the host presses Start, so a party
  // that readies up early isn't thrown into a round nobody asked for yet.
  if ($('#overlay-over').hidden) return;
  hostStartRound();
}

/** Every "play again" is a vote; the round starts when the party is unanimous. */
function partyPlayAgain() {
  if (!room) return;
  const want = !iAmReady();
  room.setReady(want);
  if (!room.isHost) {
    // Optimistic, so the button responds before the host's roster comes back.
    if (lobby.roster[lobby.seat]) lobby.roster[lobby.seat].ready = want;
    renderPartyOver();
  }
}

/** Back to the party after a round is abandoned. The room survives. */
function returnToLobby(msg = '') {
  epoch++;
  animator.cancel();
  if (session) clearTimeout(session.aiTimer);
  session = null;
  closeOverlays();
  partyReturn = '';
  onlineErr.textContent = '';
  showOnlineLobby();
  show('screen-online');
  renderLobby();
  if (msg) lobbyMsg.textContent = msg;
}

/** The room itself is gone: back to the setup pane with the reason. */
function netFail(err) {
  const msg = err?.message || 'Connection problem';
  epoch++;
  animator.cancel();
  if (session) clearTimeout(session.aiTimer);
  session = null;
  closeOverlays();
  partyReturn = '';
  teardownRoom();
  onlineErr.textContent = msg;
  showOnlineSetup();
  show('screen-online');
}

function teardownRoom() {
  if (room) { try { room.destroy(); } catch { /* ignore */ } }
  room = null;
  lobby = { roster: [], capacity: MAX_PARTY, seat: 0, started: false };
}

/** Roster updates land here from both ends and repaint whichever view is up. */
function onLobbyUpdate(info) {
  lobby = { ...lobby, ...info };
  renderLobby();
  if (!$('#overlay-over').hidden) renderPartyOver();
  maybeAutoStart();
}

const hostHandlers = () => ({
  onLobby: onLobbyUpdate,
  onMove: ({ idx, from }) => enqueue(idx, 'net', from),
  onEnded: ({ reason, mid }) => {
    // Somebody dropped mid-round. The round cannot continue — every client is
    // replaying a move stream keyed to seat indices — but the party can.
    if (mid && room) room.endRound(reason);
    returnToLobby(reason || 'A player left the game');
  },
  onError: netFail,
});

const clientHandlers = () => ({
  onLobby: onLobbyUpdate,
  onStart: ({ config, players, seat }) => startOnline(config, players, seat),
  onMove: ({ idx }) => enqueue(idx, 'net'),
  onEnded: ({ reason }) => returnToLobby(reason),
  onError: netFail,
});

/* ----------------------------------------------------------- the map picker */

/**
 * The host changing the map between rounds. The result card is a fixed overlay,
 * so it has to be put away while the picker is up and brought back after —
 * otherwise it floats on top of the mode grid.
 */
function openMapPicker(from) {
  partyReturn = from;
  $('#overlay-over').hidden = true;
  show('screen-modes');
}

function closeMapPicker() {
  const from = partyReturn;
  partyReturn = '';
  if (from === 'over' && session) {
    show('screen-game');
    $('#overlay-over').hidden = false;
    renderPartyOver();
  } else {
    show('screen-online');
    showOnlineLobby();
    renderLobby();
  }
}

$$('[data-map-picker]').forEach((b) => b.addEventListener('click', () => {
  unlockAudio(); sfx.ui(); haptic(8);
  openMapPicker('lobby');
}));

/* ------------------------------------------------------------ online wiring */

$('#online-name').addEventListener('input', (e) => setMyName(e.target.value));
$('#lobby-name').addEventListener('input', (e) => setMyName(e.target.value));

$('#online-host').addEventListener('click', async () => {
  unlockAudio(); sfx.ui();
  onlineErr.textContent = 'Opening a party…';
  try {
    teardownRoom();
    room = await hostRoom({ capacity: MAX_PARTY, name: myName(), handlers: hostHandlers() });
    onlineErr.textContent = '';
    showOnlineLobby();
    renderLobby();
  } catch (e) { netFail(e); }
});

async function joinWithCode(code) {
  onlineErr.textContent = 'Connecting…';
  try {
    teardownRoom();
    room = await joinRoom({ code, name: myName(), handlers: clientHandlers() });
    onlineErr.textContent = '';
    showOnlineLobby();
    renderLobby();
  } catch (e) { netFail(e); }
}

$('#online-join').addEventListener('click', () => {
  unlockAudio(); sfx.ui();
  const code = normaliseCode($('#online-code').value);
  if (code.length < 5) { onlineErr.textContent = 'Enter the 5-character party code'; return; }
  joinWithCode(code);
});

$('#online-code').addEventListener('input', (e) => {
  e.target.value = normaliseCode(e.target.value);
});

$('#online-ready').addEventListener('click', () => {
  if (!room) return;
  sfx.ui(); haptic(10);
  room.setReady(!iAmReady());
  if (!room.isHost && lobby.roster[lobby.seat]) {
    lobby.roster[lobby.seat].ready = !lobby.roster[lobby.seat].ready;
    renderLobby();
  }
});

$('#online-begin').addEventListener('click', () => {
  if (!room?.isHost) return;
  sfx.ui();
  hostStartRound();
});

/** A link beats a code: it carries the room and opens straight into it. */
function partyLink() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = `?party=${room?.code || ''}`;
  return url.toString();
}

$('#online-share').addEventListener('click', async () => {
  if (!room?.code) return;
  sfx.ui();
  const url = partyLink();
  const text = `Join my BUST party — code ${room.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'BUST', text, url }); return; }
    await navigator.clipboard.writeText(url);
    lobbyMsg.textContent = 'Link copied — paste it to your friends';
    setTimeout(renderLobby, 2000);
  } catch {
    // A cancelled share throws too, so only say something if there is nothing
    // useful the player could do next.
    if (!navigator.share) lobbyMsg.textContent = url;
  }
});

$('#online-copy').addEventListener('click', async () => {
  if (!room?.code) return;
  sfx.ui();
  try {
    await navigator.clipboard.writeText(room.code);
    lobbyMsg.textContent = 'Code copied';
    setTimeout(renderLobby, 1600);
  } catch { lobbyMsg.textContent = `Share this code: ${room.code}`; }
});

$('#online-leave').addEventListener('click', () => {
  sfx.ui();
  teardownRoom();
  onlineErr.textContent = '';
  showOnlineSetup();
});

/**
 * A party link, opened cold: drop straight into the room rather than making
 * someone read a code off it and type it back in. The query is stripped after,
 * so a refresh doesn't try to rejoin a party that has since moved on.
 */
function joinFromLink() {
  const code = normaliseCode(new URLSearchParams(location.search).get('party') || '');
  if (code.length < 5) return;
  try { history.replaceState(null, '', location.pathname); } catch { /* file:// */ }
  $('#online-code').value = code;
  show('screen-online');
  showOnlineSetup();
  joinWithCode(code);
}

/* ---------------------------------------------------------------- settings -- */

/**
 * The three chips on the home screen. Sound and haptics were rendered with a
 * stored setting behind them but nothing ever read the taps or applied the
 * stored value, so sound could not be turned off and a saved preference was
 * forgotten on every load.
 */
function paintToggles() {
  const sound = $('#toggle-sound');
  const hap = $('#toggle-haptics');
  if (sound) {
    sound.textContent = settings.sound ? 'Sound on' : 'Sound off';
    sound.setAttribute('aria-pressed', String(!!settings.sound));
  }
  if (hap) {
    hap.textContent = settings.haptics ? 'Haptics on' : 'Haptics off';
    hap.setAttribute('aria-pressed', String(!!settings.haptics));
  }
  setSoundEnabled(!!settings.sound);
  applySpeed();
}

$('#toggle-sound')?.addEventListener('click', () => {
  settings.sound = !settings.sound;
  saveSettings();
  paintToggles();
  unlockAudio(); sfx.ui();   // after the repaint, so turning it on is audible
  haptic(8);
});

$('#toggle-haptics')?.addEventListener('click', () => {
  settings.haptics = !settings.haptics;
  saveSettings();
  paintToggles();
  sfx.ui(); haptic(14);
});

// Two gears, so the chip cycles rather than toggling on and off.
$('#toggle-speed')?.addEventListener('click', () => {
  unlockAudio(); sfx.ui(); haptic(8);
  setSpeed(gameSpeed() === 1 ? 2 : 1);
});

$('#pause-speed')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setSpeed(Number(btn.dataset.v));
});

/* ------------------------------------------------------------------ chrome -- */

// Watch the screen, not the board area: `fitBoard` resizes the board area, so
// observing that would feed its own output straight back in.
const ro = new ResizeObserver(() => { if (currentScreen === 'screen-game') fitBoard(); });
ro.observe($('#screen-game'));

$$('.scroller').forEach((el) => el.addEventListener('scroll', syncScrollFades, { passive: true }));
window.addEventListener('resize', syncScrollFades);

// A scroller overflows because of what is *inside* it — a party roster growing
// by a row, a ladder being built — and a ResizeObserver on the box never sees
// that: the box is the same size either way. So watch the content instead,
// coalesced onto one frame so a full rebuild costs one measurement.
const scrollRo = new ResizeObserver(syncScrollFades);
let fadeQueued = false;
const queueScrollFades = () => {
  if (fadeQueued) return;
  fadeQueued = true;
  requestAnimationFrame(() => { fadeQueued = false; syncScrollFades(); });
};
const scrollMo = new MutationObserver(queueScrollFades);
$$('.scroller').forEach((el) => {
  scrollRo.observe(el);
  scrollMo.observe(el, { childList: true, subtree: true, characterData: true });
});
window.addEventListener('orientationchange', () => setTimeout(fitBoard, 220));

document.addEventListener('visibilitychange', () => {
  if (document.hidden && session && !session.over && currentScreen === 'screen-game') {
    if (session.mode !== 'online') $('#overlay-pause').hidden = false;
  }
});

// Block the double-tap-to-zoom gesture that would otherwise fight the board.
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
  });
}

paintIcons();               // fill the static chrome's icon slots once
applyTheme(MODES[modeKey].theme);
paintCustomPanel();
paintToggles();
syncNameInputs();
renderModeGrid();
syncRosterToMode();
refreshShapeLines();
show('screen-home');
joinFromLink();             // a shared party link opens straight into the room

