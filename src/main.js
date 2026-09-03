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
  PHASE_PLACE, PHASE_PLAY, PHASE_OVER,
} from './engine.js';
import { chooseMove, difficultyLabel, DIFFICULTY_ORDER } from './ai.js';
import {
  RANKS, rankFor, rankIndexFor, progressToNext, nextRank,
  matchmake, scoreResult, recordMatch, loadProfile, saveProfile,
} from './rank.js';
import { BoardAnimator, PLAYER_COLORS, hitTest, blockedPlacementTiles, setBoardSkin } from './render.js';
import { MODES, MODE_ORDER, modeFor, buildSetup, describeSetup } from './modes.js';
import { sfx, unlock as unlockAudio, setEnabled as setSoundEnabled, buzz } from './audio.js';
import { hostRoom, joinRoom, normaliseCode } from './net.js';

/* ---------------------------------------------------------------- settings -- */

const SETTINGS_KEY = 'bust.settings.v1';
const settings = loadSettings();

function loadSettings() {
  const base = { sound: true, haptics: true, mode: 'duel', custom: null };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch { return base; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const haptic = (ms) => { if (settings.haptics) buzz(ms); };

/* ------------------------------------------------------------------- modes -- */

// Up to four players get their own screen edge, rotated to face them. Beyond
// that the chips go into flat rails top and bottom — see `.is-crowded`.
const SEAT_ORDER = {
  1: ['bottom'],
  2: ['bottom', 'top'],
  3: ['bottom', 'top', 'left'],
  4: ['bottom', 'top', 'left', 'right'],
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

// Badge tints per rank, weakest → strongest.
const RANK_COLORS = {
  wood: '#8A5A3C', stone: '#8C8C94', bronze: '#B87333', iron: '#6E7B8B',
  silver: '#AEB6BD', gold: '#E7B023', platinum: '#3FB6C6',
  diamond: '#4C7DF0', master: '#9B72E0', legend: '#F24BA0',
};

/** @type {object} persisted trophy profile */
let profile = loadProfile();

/* --------------------------------------------------------------------- dom -- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const canvas = $('#board');
const boardArea = $('#board-area');
const turnBanner = $('#turn-banner');
const turnText = $('#turn-text');
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
}

function closeOverlays() {
  $('#overlay-pause').hidden = true;
  $('#overlay-over').hidden = true;
}

/* ----------------------------------------------------------------- session -- */

/** @type {null | object} */
let session = null;
let epoch = 0; // bumped on every new/abandoned game to void stale async work

function playerLabel(p) {
  return p.name;
}

function makePlayers(mode, count, difficulty) {
  const colours = PLAYER_COLORS;
  if (mode === 'solo') {
    return Array.from({ length: count }, (_, i) => ({
      name: i === 0 ? 'You' : (count === 2 ? 'Bot' : `Bot ${i}`),
      kind: i === 0 ? 'human' : 'ai',
      difficulty,
    }));
  }
  if (mode === 'online') {
    return Array.from({ length: count }, (_, i) => ({ name: `Player ${i + 1}`, kind: 'human' }));
  }
  return Array.from({ length: count }, (_, i) => ({ name: colours[i].name, kind: 'human' }));
}

/**
 * @param {object} opts
 * @param {'solo'|'local'|'online'|'ranked'} opts.mode
 * @param {number} opts.cols @param {number} opts.rows
 * @param {Array} opts.players
 * @param {number} [opts.localSeat] which player this device controls (online)
 * @param {object} [opts.room] net room handle (online)
 * @param {number[]} [opts.ratings] trophy-equivalent rating per player id (ranked)
 */
function startGame({
  mode, cols, rows, players, localSeat = 0, room = null, ratings = null,
  teams = null, blocked = null, modeKey: mk = modeKey,
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
    state: createGame({ cols, rows, players, teams, blocked }),
    queue: [],
    pumping: false,
    aiTimer: 0,
    over: false,
  };

  keyCursor = Math.floor((rows * cols) / 2);
  keyActive = false;
  lastAnnounced = '';

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
  return `
    <div class="score-chip" data-pid="${pid}">
      <span class="dot" style="background:${PLAYER_COLORS[pid].ball}"></span>
      <span class="val num">0</span>
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
  const crowded = n > 4 || session.mode !== 'local';
  screen.classList.toggle('is-crowded', crowded);

  if (crowded) {
    const rot = (pid) => (pid - localSeat + n) % n;   // you always sit first
    const ordered = [...state.players].sort((a, b) => rot(a.id) - rot(b.id)).map((p) => p.id);
    const half = Math.ceil(n / 2);
    const rails = { bottom: ordered.slice(0, half), top: ordered.slice(half) };
    for (const [slot, ids] of Object.entries(rails)) {
      const el = document.querySelector(`.seat-${slot}`);
      if (!el || !ids.length) continue;
      el.classList.add('is-shown');
      el.innerHTML = ids.map((pid) => chipHtml(state, pid)).join('');
    }
    return;
  }

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------ display -- */

function fitBoard() {
  if (!session) return;
  // The side seat columns have a fixed width in CSS, so whatever the board area
  // reports is already clear of them.
  const r = boardArea.getBoundingClientRect();
  const w = Math.max(80, r.width);
  const h = Math.max(80, r.height);
  animator.resize(w, h, session.state.cols, session.state.rows);
  refreshBoardOnly();
}

function chrome() {
  const s = session.state;
  const view = { walls: s.blocked, teams: s.teams };
  if (s.phase === PHASE_PLACE) view.blocked = blockedPlacementTiles(s);
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

  turnText.textContent = bannerText();
  turnBanner.style.background = s.phase === PHASE_OVER
    ? 'rgba(255,255,255,0.24)'
    : hexToSoft(PLAYER_COLORS[s.turn].ball);

  if (s.phase !== PHASE_OVER) {
    const you = tiles.map((t, pid) => `${playerLabel(s.players[pid])} ${t}`).join(', ');
    announce(`${bannerText()}. Tiles: ${you}.`);
  }

  refreshBoardOnly();
}

function hexToSoft(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.85)`;
}

function bannerText() {
  const s = session.state;
  if (s.phase === PHASE_OVER) return 'Game over';
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
function enqueue(idx, source) {
  if (!session || session.over) return;
  session.queue.push({ idx, source });
  pump();
}

async function pump() {
  if (!session || session.pumping) return;
  session.pumping = true;
  const myEpoch = epoch;

  try {
    while (session && epoch === myEpoch && session.queue.length) {
      const { idx, source } = session.queue.shift();
      const s = session.state;

      // Host referees: an illegal or out-of-turn packet is simply dropped, and
      // because clients only apply on echo they stay in step automatically.
      if (source === 'net' && session.room?.isHost) {
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
      refresh();

      if (r.state.phase === PHASE_OVER) { finish(); return; }
      scheduleAI();
    }
  } finally {
    if (session && epoch === myEpoch) session.pumping = false;
  }
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
  // A beat of "thinking" so moves don't teleport past the player.
  session.aiTimer = setTimeout(() => {
    if (!session || epoch !== myEpoch) return;
    const move = chooseMove(session.state, p.difficulty);
    if (move === null || move === undefined) return;
    enqueue(move, 'ai');
  }, s.phase === PHASE_PLACE ? 520 : 400);
}

/* -------------------------------------------------------------------- input -- */

/** True when this device may act on the current turn right now. */
function canActNow() {
  if (!session || session.over) return false;
  const s = session.state;
  if (s.phase === PHASE_OVER) return false;
  if (!controlsPlayer(s.turn)) return false;
  if (session.queue.length || session.pumping) return false; // mid-cascade
  return true;
}

/** Send a chosen tile through the same path a tap would take. */
function commitTile(idx) {
  const s = session.state;
  if (!isLegalMove(s, idx)) { sfx.deny(); haptic(26); return; }
  if (session.mode === 'online' && !session.room?.isHost) {
    // Clients propose; they apply only when the host echoes it back.
    session.room.sendMove(idx);
    return;
  }
  enqueue(idx, 'local');
}

function onBoardPointer(ev) {
  unlockAudio();
  if (!canActNow()) return;
  const rect = canvas.getBoundingClientRect();
  const pt = ev.changedTouches ? ev.changedTouches[0] : ev;
  const idx = hitTest(animator.L, pt.clientX - rect.left, pt.clientY - rect.top);
  if (idx < 0) return;
  keyActive = false; // a tap takes over from the keyboard cursor
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
  dEl.className = `trophy-delta ${up ? 'up' : 'down'}`;
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
    li.innerHTML = `<span>${escapeHtml(playerLabel(s.players[b.oppId]))} · ${Math.round(b.oppRating)} 🏆</span>`
      + `<span>${b.result === 1 ? 'beat' : b.result === 0 ? 'lost to' : 'tied'}${beat ? ' ↑' : ''}</span>`;
    bd.appendChild(li);
  });
  return bundle;
}

/* ------------------------------------------------------------------ ranked -- */

function paintBadge(el, rank) {
  if (!el) return;
  el.textContent = rank.name[0];
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
  $('#strip-fill').style.width = `${Math.round(progressToNext(profile.trophies).frac * 100)}%`;
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
  paintModeHero('ranked-hero', mode, `${describeSetup(mode)} · ${rank.pool.map(difficultyLabel).join('/')} bots`);

  const here = rankIndexFor(profile.trophies);
  const list = $('#ladder-list');
  list.innerHTML = '';
  RANKS.forEach((r, i) => {
    const li = document.createElement('li');
    if (i === here) li.classList.add('is-here');
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
    min.textContent = `${r.min} 🏆`;
    li.appendChild(min);
    list.appendChild(li);
  });
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
    teams: setup.teams, blocked: setup.blocked,
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
  const { mode, state, localSeat, room } = session;
  const players = state.players.map((p) => ({ name: p.name, kind: p.kind, difficulty: p.difficulty }));
  if (mode === 'online') {
    if (!room?.isHost) return;
    room.restart(players);
  }
  startGame({ mode, cols: state.cols, rows: state.rows, players, localSeat, room });
}

function quitToMenu() {
  epoch++;
  animator.cancel();
  if (session?.room) { try { session.room.destroy(); } catch { /* ignore */ } }
  if (session) clearTimeout(session.aiTimer);
  session = null;
  closeOverlays();
  applyTheme(MODES[modeKey].theme);
renderModeGrid();
syncRosterToMode();
refreshShapeLines();
show('screen-home');
}

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
  });
});

/* -------------------------------------------------------------- menu wiring -- */

$$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  unlockAudio(); sfx.ui(); haptic(8);
  show(b.dataset.goto);
}));

/* ------------------------------------------------------------- mode picker -- */

function paintModeHero(prefix, mode, subOverride) {
  const g = $(`#${prefix}-glyph`);
  const n = $(`#${prefix}-name`);
  const sub = $(`#${prefix}-sub`);
  if (g) g.textContent = mode.glyph;
  if (n) n.textContent = mode.name;
  if (sub) sub.textContent = subOverride || `${mode.tagline} · ${describeSetup(mode)}`;
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
      <span class="mode-glyph" aria-hidden="true">${MODES[key].glyph}</span>
      <span>
        <span class="mode-card-name">${escapeHtml(MODES[key].name)}</span><br>
        <span class="mode-card-tag">${escapeHtml(MODES[key].tagline)} · ${escapeHtml(describeSetup(m))}</span>
      </span>
      <span class="mode-card-check" aria-hidden="true">✓</span>`;
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
}

$('#mode-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.mode-card');
  if (!card) return;
  unlockAudio(); sfx.ui(); haptic(10);
  selectMode(card.dataset.mode);
});

$('#modes-done').addEventListener('click', () => { sfx.ui(); applyTheme(MODES[modeKey].theme);
renderModeGrid();
syncRosterToMode();
refreshShapeLines();
show('screen-home'); });

/* custom setup ------------------------------------------------------------- */

function readCustom() {
  const seats = Number(segValue('custom-seats')) || 4;
  const n = Number(segValue('custom-board')) || 9;
  const wallDensity = Number(segValue('custom-walls')) || 0;
  const wantTeams = segValue('custom-teams') === 'on';
  // Teams need an even table; seats alternate so turn order alternates sides.
  const teams = wantTeams && seats % 2 === 0
    ? Array.from({ length: seats }, (_, i) => i % 2) : null;
  customCfg = { seats, board: [n, n], teams, wallDensity };
  settings.custom = customCfg;
  saveSettings();
  $('#custom-err').textContent = wantTeams && seats % 2
    ? 'Teams need an even number of seats — playing free-for-all.' : '';
  renderModeGrid();
  refreshShapeLines();
  syncRosterToMode();
}

['custom-seats', 'custom-board', 'custom-teams', 'custom-walls'].forEach((id) => {
  $(`#${id}`).addEventListener('click', (e) => { if (e.target.closest('.seg-btn')) readCustom(); });
});

/* ------------------------------------------------------------- play screens -- */

/** The "here's what you're about to play" line on every play screen. */
function refreshShapeLines() {
  const m = currentMode();
  const shape = `${m.name} · ${describeSetup(m)}`;
  $('#solo-shape').textContent = `${shape}. You against ${m.seats - 1} bot${m.seats > 2 ? 's' : ''}.`;
  $('#local-shape').textContent = `${shape}. One device — fill the seats with any mix of people and bots.`;
  $('#online-shape').textContent = `${shape}. One player hosts and shares the room code.`;
  paintModeHero('hero', m);
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
    teams: setup.teams, blocked: setup.blocked, players,
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
    const diffBtns = DIFFICULTY_ORDER.map((k) => (
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
  else if (btn.dataset.diff) localRoster[i].difficulty = btn.dataset.diff;
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
    teams: setup.teams, blocked: setup.blocked, players,
  });
});

/* ------------------------------------------------------------------- online -- */

let room = null;
let lobbyInfo = { count: 0, capacity: 0, seat: 0 };
let onlineSetup = null;   // host: the setup this room was opened with

/** Join a game the host has described; the theme follows their chosen mode. */
function startOnline(config, players, seat) {
  if (config.modeKey && MODES[config.modeKey]) {
    modeKey = config.modeKey;
    applyTheme(MODES[modeKey].theme);
  }
  startGame({
    mode: 'online', cols: config.cols, rows: config.rows,
    teams: config.teams || null,
    blocked: config.blocked || null,
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

function renderLobby() {
  $('#online-room-code').textContent = room?.code || '—';
  const list = $('#online-players');
  list.innerHTML = '';
  for (let i = 0; i < lobbyInfo.capacity; i++) {
    const seated = i < lobbyInfo.count;
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${seated ? PLAYER_COLORS[i].ball : 'rgba(255,255,255,.25)'}"></span>
      <span>${seated ? `Player ${i + 1}` : 'Waiting…'}</span>
      ${i === lobbyInfo.seat ? '<span class="you">you</span>' : ''}`;
    list.appendChild(li);
  }
  const ready = lobbyInfo.count === lobbyInfo.capacity;
  const begin = $('#online-begin');
  begin.classList.toggle('is-hidden', !(room?.isHost && ready));
  lobbyMsg.textContent = room?.isHost
    ? (ready ? '' : `Waiting for ${lobbyInfo.capacity - lobbyInfo.count} more…`)
    : 'Waiting for the host to start…';
}

function teardownRoom() {
  if (room) { try { room.destroy(); } catch { /* ignore */ } }
  room = null;
}

function netFail(err) {
  const msg = err?.message || 'Connection problem';
  if (currentScreen === 'screen-game') {
    epoch++;
    animator.cancel();
    session = null;
    closeOverlays();
    onlineErr.textContent = msg;
    showOnlineSetup();
    show('screen-online');
  } else {
    onlineErr.textContent = msg;
    showOnlineSetup();
  }
  teardownRoom();
}

const clientHandlers = () => ({
  onLobby: (info) => { lobbyInfo = info; renderLobby(); },
  onStart: ({ config, players, seat }) => startOnline(config, players, seat),
  onRestart: ({ config, players, seat }) => startOnline(config, players, seat),
  onMove: ({ idx }) => enqueue(idx, 'net'),
  onError: netFail,
  onClose: ({ mid }) => { if (mid) netFail(new Error('A player left the game')); },
});

$('#online-host').addEventListener('click', async () => {
  unlockAudio(); sfx.ui();
  onlineErr.textContent = 'Connecting…';
  const setup = currentSetup();
  const capacity = setup.seats;
  onlineSetup = setup;
  try {
    teardownRoom();
    room = await hostRoom({
      capacity,
      // Everything a client needs to build a byte-identical board.
      config: {
        cols: setup.cols, rows: setup.rows, modeKey,
        teams: setup.teams ? Array.from(setup.teams) : null,
        blocked: setup.blocked ? Array.from(setup.blocked) : null,
      },
      handlers: {
        onLobby: (info) => { lobbyInfo = info; renderLobby(); },
        onMove: ({ idx, from }) => {
          // Only honour a packet from the player whose turn it actually is.
          if (session && session.state.turn === from) enqueue(idx, 'net');
        },
        onError: netFail,
        onClose: ({ mid }) => { if (mid) netFail(new Error('A player left the game')); },
      },
    });
    onlineErr.textContent = '';
    showOnlineLobby();
    renderLobby();
  } catch (e) { netFail(e); }
});

$('#online-join').addEventListener('click', async () => {
  unlockAudio(); sfx.ui();
  const code = normaliseCode($('#online-code').value);
  if (code.length < 5) { onlineErr.textContent = 'Enter the 5-character room code'; return; }
  onlineErr.textContent = 'Connecting…';
  try {
    teardownRoom();
    room = await joinRoom({ code, handlers: clientHandlers() });
    onlineErr.textContent = '';
    showOnlineLobby();
    renderLobby();
  } catch (e) { netFail(e); }
});

$('#online-code').addEventListener('input', (e) => {
  e.target.value = normaliseCode(e.target.value);
});

$('#online-begin').addEventListener('click', () => {
  if (!room?.isHost) return;
  sfx.ui();
  const setup = onlineSetup || currentSetup();
  const players = makePlayers('online', lobbyInfo.capacity);
  room.start(players);
  startGame({
    mode: 'online', cols: setup.cols, rows: setup.rows,
    teams: setup.teams, blocked: setup.blocked,
    players, localSeat: 0, room,
  });
});

$('#online-copy').addEventListener('click', async () => {
  if (!room?.code) return;
  try {
    await navigator.clipboard.writeText(room.code);
    lobbyMsg.textContent = 'Code copied';
    setTimeout(renderLobby, 1400);
  } catch { lobbyMsg.textContent = `Share this code: ${room.code}`; }
});

$('#online-leave').addEventListener('click', () => {
  sfx.ui();
  teardownRoom();
  onlineErr.textContent = '';
  showOnlineSetup();
});

/* ------------------------------------------------------------------ chrome -- */

const ro = new ResizeObserver(() => { if (currentScreen === 'screen-game') fitBoard(); });
ro.observe(boardArea);
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

applyTheme(MODES[modeKey].theme);
renderModeGrid();
syncRosterToMode();
refreshShapeLines();
show('screen-home');
