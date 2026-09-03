/**
 * BUST — canvas board renderer.
 *
 * Draws a board snapshot and plays back the frame script that `applyMove`
 * returns, one cascade wave at a time. The renderer owns no game rules; it is
 * handed boards and told to show them.
 */

import { EMPTY, MAX_BALLS, neighbors, legalPlacements, PHASE_PLACE } from './engine.js';

/**
 * Eight seat colours. The first four are the original palette and must not
 * move — saved games, screenshots and the seat chips all key off the index.
 * The last four were chosen for hue separation from those, so an eight-player
 * Mayhem board stays readable.
 */
export const PLAYER_COLORS = [
  { ball: '#F2564B', tint: 'rgba(242, 86, 75, 0.20)', ink: '#C6392F', name: 'Red' },
  { ball: '#25B7E8', tint: 'rgba(37, 183, 232, 0.20)', ink: '#1487B0', name: 'Blue' },
  { ball: '#F0A430', tint: 'rgba(240, 164, 48, 0.22)', ink: '#C07A14', name: 'Amber' },
  { ball: '#9B72E0', tint: 'rgba(155, 114, 224, 0.20)', ink: '#6F49B4', name: 'Violet' },
  { ball: '#3EB56B', tint: 'rgba(62, 181, 107, 0.20)', ink: '#2A8850', name: 'Green' },
  { ball: '#EE4B96', tint: 'rgba(238, 75, 150, 0.20)', ink: '#BB2E6E', name: 'Pink' },
  { ball: '#0FA8A0', tint: 'rgba(15, 168, 160, 0.20)', ink: '#0B7B75', name: 'Teal' },
  { ball: '#6B7A99', tint: 'rgba(107, 122, 153, 0.22)', ink: '#4B5770', name: 'Slate' },
];

// Repainted from CSS custom properties whenever the theme changes, so the
// board always sits in the same world as the rest of the app.
export const BOARD_SKIN = {
  tile: '#F8EBDA',
  tileDim: '#E0C6B4',
  wall: '#8B6B57',
  wallInk: 'rgba(0,0,0,0.20)',
  shadow: 'rgba(90, 45, 25, 0.16)',
};

export function setBoardSkin(next) {
  Object.assign(BOARD_SKIN, next);
}

const PIP = '#FFFFFF';

/**
 * Disc radius as a share of the tile. The balls are the thing you actually read
 * the board by — their colour, and how many pips they carry — so they take the
 * majority of the tile and leave just enough bed showing for the territory tint
 * and the legal-move ring to register.
 */
const DISC_R = 0.40;

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* ------------------------------------------------------------------ layout -- */

export function computeLayout(cssW, cssH, cols, rows) {
  const pad = Math.max(6, Math.min(cssW, cssH) * 0.02);
  const gap = Math.max(4, Math.min(cssW, cssH) * 0.016);
  const tile = Math.min(
    (cssW - pad * 2 - gap * (cols - 1)) / cols,
    (cssH - pad * 2 - gap * (rows - 1)) / rows,
  );
  const boardW = tile * cols + gap * (cols - 1);
  const boardH = tile * rows + gap * (rows - 1);
  return {
    cols, rows, tile, gap,
    x0: (cssW - boardW) / 2,
    y0: (cssH - boardH) / 2,
    boardW, boardH,
  };
}

export function cellCentre(L, i) {
  const x = i % L.cols;
  const y = (i / L.cols) | 0;
  return {
    cx: L.x0 + x * (L.tile + L.gap) + L.tile / 2,
    cy: L.y0 + y * (L.tile + L.gap) + L.tile / 2,
  };
}

/** Hit-test a pointer position; returns a tile index or -1. */
export function hitTest(L, px, py) {
  const step = L.tile + L.gap;
  const gx = Math.floor((px - L.x0 + L.gap / 2) / step);
  const gy = Math.floor((py - L.y0 + L.gap / 2) / step);
  if (gx < 0 || gy < 0 || gx >= L.cols || gy >= L.rows) return -1;
  // Allow a forgiving touch target: accept anywhere in the tile+gap cell.
  return gy * L.cols + gx;
}

/* ------------------------------------------------------------- primitives -- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Pip layout inside a disc, matching the die-face look. */
function pipOffsets(n, r) {
  const d = r * 0.42;
  if (n <= 1) return [[0, 0]];
  if (n === 2) return [[-d, 0], [d, 0]];
  return [[-d, -d * 0.72], [d, -d * 0.72], [0, d * 0.86]];
}

function drawDisc(ctx, cx, cy, r, color, count, scale = 1) {
  if (scale <= 0.001 || r <= 0) return;
  const rr = r * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rr, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  if (count > 0) {
    const pr = Math.max(1, rr * 0.148);
    ctx.fillStyle = PIP;
    for (const [ox, oy] of pipOffsets(count, rr)) {
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy, pr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- drawing -- */

/** Territory tint by side: partners share one, so you read teams at a glance. */
function tintFor(view, o) {
  const teams = view.teams;
  if (!teams) return PLAYER_COLORS[o].tint;
  const lead = Array.prototype.indexOf.call(teams, teams[o]);
  return PLAYER_COLORS[lead >= 0 ? lead : o].tint;
}

/** A wall: solid, hatched, and visibly not a tile you could ever play. */
function drawWall(ctx, L, x, y, radius) {
  ctx.save();
  roundRect(ctx, x, y, L.tile, L.tile, radius);
  ctx.fillStyle = BOARD_SKIN.wall;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = BOARD_SKIN.wallInk;
  ctx.lineWidth = Math.max(1, L.tile * 0.06);
  ctx.beginPath();
  for (let k = -1; k < 3; k++) {
    ctx.moveTo(x + k * L.tile * 0.44, y + L.tile);
    ctx.lineTo(x + k * L.tile * 0.44 + L.tile, y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * @param {object} view
 * @param {Int8Array} view.owner
 * @param {Uint8Array} view.count
 * @param {Set<number>} [view.hidden]     tiles mid-bust, drawn empty
 * @param {Set<number>} [view.blocked]    placement-phase tiles that are off limits
 * @param {Set<number>} [view.legal]      tiles the local player may tap
 * @param {number} [view.popAt]           tile to pop-animate
 * @param {number} [view.popT]            0..1 progress of that pop
 * @param {number} [view.pulse]           0..1 looping pulse for the legal-move hint
 */
export function drawBoard(ctx, L, view) {
  const { owner, count } = view;
  const hidden = view.hidden || null;
  const dim = view.blocked || null;   // placement-phase "you can't open here"
  const walls = view.walls || null;   // permanent obstacles
  const land = view.land || null;     // tiles mid-landing: index -> 0..1
  const legal = view.legal || null;
  const radius = L.tile * 0.22;
  const discR = L.tile * DISC_R;

  for (let i = 0; i < owner.length; i++) {
    const x = L.x0 + (i % L.cols) * (L.tile + L.gap);
    const y = L.y0 + ((i / L.cols) | 0) * (L.tile + L.gap);

    if (walls && walls[i]) { drawWall(ctx, L, x, y, radius); continue; }

    const o = hidden && hidden.has(i) ? EMPTY : owner[i];
    const c = hidden && hidden.has(i) ? 0 : count[i];

    // Tile bed.
    ctx.save();
    ctx.shadowColor = BOARD_SKIN.shadow;
    ctx.shadowBlur = L.tile * 0.09;
    ctx.shadowOffsetY = L.tile * 0.035;
    roundRect(ctx, x, y, L.tile, L.tile, radius);
    ctx.fillStyle = dim && dim.has(i) ? BOARD_SKIN.tileDim : BOARD_SKIN.tile;
    ctx.fill();
    ctx.restore();

    // Territory tint behind the disc — partners share a tint in team modes.
    if (o !== EMPTY) {
      roundRect(ctx, x, y, L.tile, L.tile, radius);
      ctx.fillStyle = tintFor(view, o);
      ctx.fill();
    }

    // Playable hint for the local player.
    if (legal && legal.has(i)) {
      const p = view.pulse || 0;
      ctx.save();
      roundRect(ctx, x + 1.5, y + 1.5, L.tile - 3, L.tile - 3, radius - 1.5);
      ctx.strokeStyle = o === EMPTY
        ? `rgba(255,255,255,${0.30 + 0.30 * p})`
        : `rgba(255,255,255,${0.45 + 0.35 * p})`;
      ctx.lineWidth = Math.max(1.5, L.tile * 0.035);
      ctx.stroke();
      ctx.restore();
    }

    // Keyboard cursor — a bold ring the arrow keys move around.
    if (view.cursor === i) {
      ctx.save();
      roundRect(ctx, x + 1, y + 1, L.tile - 2, L.tile - 2, radius - 1);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(2, L.tile * 0.055);
      ctx.stroke();
      ctx.restore();
    }

    if (o === EMPTY || c === 0) continue;

    let scale = 1;
    if (view.popAt === i && view.popT !== undefined) {
      // Overshoot then settle, so a placed ball reads as impact.
      const t = view.popT;
      scale = t < 1 ? 1 + 0.28 * Math.sin(Math.PI * t) : 1;
    }
    if (land && land.has(i)) {
      // A ball just touched down here: snap up from small, with a shock ring.
      const t = land.get(i);
      scale = 0.45 + 0.55 * easeOut(t) + 0.20 * Math.sin(Math.PI * t);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + L.tile / 2, y + L.tile / 2, discR * (1 + 1.4 * t), 0, Math.PI * 2);
      ctx.strokeStyle = PLAYER_COLORS[o].ball;
      ctx.globalAlpha = 0.55 * (1 - t);
      ctx.lineWidth = Math.max(1.5, L.tile * 0.05 * (1 - t));
      ctx.stroke();
      ctx.restore();
    }
    drawDisc(ctx, x + L.tile / 2, y + L.tile / 2, discR, PLAYER_COLORS[o].ball, c, scale);

    // A loaded tile gets a ring — the "about to blow" tell.
    if (c === MAX_BALLS) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + L.tile / 2, y + L.tile / 2, discR * (1.13 + 0.045 * (view.pulse || 0)), 0, Math.PI * 2);
      ctx.strokeStyle = PLAYER_COLORS[o].ball;
      ctx.globalAlpha = 0.35 + 0.25 * (view.pulse || 0);
      ctx.lineWidth = Math.max(1.5, L.tile * 0.03);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Flight occupies the first LAND_AT of a wave; the rest is the landing pop.
const LAND_AT = 0.72;

/** Balls in flight during a bust wave, with a motion trail behind each. */
function drawFlyers(ctx, L, busts, t) {
  const discR = L.tile * DISC_R;
  const r = discR * 0.50;
  const flight = Math.min(1, t / LAND_AT);
  const e = easeOut(flight);

  for (const b of busts) {
    const from = cellCentre(L, b.at);
    const colour = PLAYER_COLORS[b.player].ball;

    // The tile that just burst collapses outward as its balls leave.
    if (flight < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(from.cx, from.cy, discR * (0.7 + 1.5 * flight), 0, Math.PI * 2);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.45 * (1 - flight);
      ctx.lineWidth = Math.max(1.5, L.tile * 0.06 * (1 - flight));
      ctx.stroke();
      ctx.restore();
    }
    if (flight >= 1) continue; // landed; drawBoard draws the pop from here

    for (const target of b.to) {
      const to = cellCentre(L, target);
      const cx = from.cx + (to.cx - from.cx) * e;
      const cy = from.cy + (to.cy - from.cy) * e;
      // Slight arc so the throw has some weight to it.
      const lift = Math.sin(Math.PI * flight) * L.tile * 0.12;

      ctx.save();
      // Trail: a couple of ghosts along the path already travelled.
      for (let k = 1; k <= 2; k++) {
        const te = easeOut(Math.max(0, flight - k * 0.09));
        const tx = from.cx + (to.cx - from.cx) * te;
        const ty = from.cy + (to.cy - from.cy) * te;
        const tl = Math.sin(Math.PI * Math.max(0, flight - k * 0.09)) * L.tile * 0.12;
        ctx.globalAlpha = 0.20 / k;
        drawDisc(ctx, tx, ty - tl, r * (1 - 0.16 * k), colour, 0, 1);
      }
      ctx.globalAlpha = 1;
      // Squash along the direction of travel, eased out as it arrives.
      drawDisc(ctx, cx, cy - lift, r, colour, 0, 1 + 0.12 * Math.sin(Math.PI * flight));
      ctx.restore();
    }
  }
}

/* --------------------------------------------------------------- animator -- */

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Plays a frame script. Resolves once the last wave has landed.
 *
 * Waves accelerate as a cascade runs long, so a 30-wave chain stays punchy
 * instead of holding the player hostage for six seconds.
 *
 * There is exactly one rAF loop. A `mode` flag decides what each tick does —
 * paint the breathing idle board, or advance the current playback — so the
 * idle loop and the animation loop can never fight over a shared handle (the
 * bug that used to freeze a cascade mid-wave). `play()` always settles: on the
 * last frame, or if `cancel()` interrupts it, so nothing awaiting it can hang.
 */
export class BoardAnimator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.L = null;
    this.staticView = null;
    this.speed = 1;

    this._mode = 'stopped'; // 'stopped' | 'idle' | 'play'
    this._rafId = 0;
    this._looping = false;
    this._lastTick = 0;
    this._wd = 0; // watchdog interval — drives playback when rAF is starved
    this._play = null; // { frames, chrome, onEvent, idx, waveNo, announced, frameStart, resolve }
  }

  resize(cssW, cssH, cols, rows) {
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 3);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.L = computeLayout(cssW, cssH, cols, rows);
    if (this._mode !== 'play') this.renderStatic();
    return this.L;
  }

  /** Show a board with no animation running. */
  setView(view) {
    this.staticView = view;
    if (this._mode !== 'play') this.renderStatic();
  }

  renderStatic() {
    if (!this.L || !this.staticView) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const pulse = 0.5 + 0.5 * Math.sin(nowMs() / 480);
    drawBoard(ctx, this.L, { ...this.staticView, pulse });
  }

  /* -- the single loop -------------------------------------------------- */

  _ensureLoop() {
    if (this._looping) return;
    this._looping = true;
    this._lastTick = nowMs();
    const tick = (now) => {
      this._lastTick = nowMs(); // only the real rAF loop refreshes this
      if (this._mode === 'stopped') { this._looping = false; this._rafId = 0; return; }
      if (this._mode === 'play') this._advance(now);
      else this.renderStatic();
      if (this._mode === 'stopped') { this._looping = false; this._rafId = 0; return; }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  /**
   * `requestAnimationFrame` is paused while the tab is hidden and throttled
   * hard under heavy jank. That would freeze a cascade mid-wave and leave
   * `play()`'s awaiter — and the whole move queue behind it — hung until the
   * tab came back. This interval force-advances playback whenever the rAF loop
   * has gone quiet, so a game left in the background still resolves its turns.
   */
  _startWatchdog() {
    if (this._wd) return;
    const id = setInterval(() => {
      if (this._mode !== 'play') return;
      const t = nowMs();
      if (t - this._lastTick > 150) this._advance(t); // rAF has gone quiet
    }, 100);
    if (id && typeof id.unref === 'function') id.unref(); // don't hold Node's loop open
    this._wd = id;
  }

  _stopWatchdog() {
    if (this._wd) clearInterval(this._wd);
    this._wd = 0;
  }

  /** Idle loop so the legal-move hint keeps breathing between turns. */
  startIdle() {
    if (this._mode === 'play') return;
    this._mode = 'idle';
    this._ensureLoop();
  }

  stopIdle() {
    if (this._mode !== 'idle') return;
    this._mode = 'stopped';
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._looping = false;
    this._stopWatchdog();
  }

  /**
   * @param {Array} frames  from engine.applyMove
   * @param {object} chrome extra view props (legal/blocked sets) to keep drawing
   * @param {(evt: {type:string, wave?:number, busts?:Array}) => void} [onEvent]
   * @returns {Promise<void>} resolves when the last frame has landed
   */
  play(frames, chrome = {}, onEvent = null) {
    // Settle any playback already in flight so its awaiter is never stranded.
    this._settlePlay();
    return new Promise((resolve) => {
      if (!frames || !frames.length) { resolve(); return; }
      this._mode = 'play';
      this._play = {
        frames, chrome, onEvent,
        idx: 0, waveNo: 0, announced: -1, frameStart: nowMs(),
        resolve,
      };
      this._ensureLoop();
      this._startWatchdog();
    });
  }

  /**
   * How long one frame of the script is held.
   *
   * A cascade is the whole point of the game, so it is paced to be *watchable*:
   * a wave lasts long enough to see which tiles went, where the balls flew, and
   * whose colour they landed in. Later waves still tighten up — a 30-wave chain
   * would outstay its welcome at full length — but the ramp is gentle and the
   * floor is high enough that the tail of a long chain is never a blur.
   */
  _durationFor(f, k) {
    const s = this.speed || 1;
    if (f.kind === 'place' || f.kind === 'open') return 300 / s;
    if (f.kind === 'settle') return 240 / s;
    return Math.max(190, 440 - k * 20) / s;
  }

  _advance(now) {
    const p = this._play;
    if (!p) { this._mode = 'idle'; return; }
    if (p.frameStart === null) p.frameStart = now; // paranoia; play() seeds it

    // Retire every whole frame the elapsed time now covers — a tab that was
    // hidden for a while can wake many frames behind — then draw the one still
    // in progress. Leftover time carries forward so catch-up stays exact.
    let guard = 0;
    while (p.idx < p.frames.length && guard++ < 100000) {
      const f = p.frames[p.idx];
      if (p.announced !== p.idx) {
        p.announced = p.idx;
        try { p.onEvent?.({ type: f.kind, wave: p.waveNo, busts: f.busts, frame: f }); } catch { /* sfx/haptics are cosmetic */ }
      }

      const dur = Math.max(1, this._durationFor(f, p.waveNo));
      let t = (now - p.frameStart) / dur;
      if (!(t >= 0)) t = 0; // NaN, or a clock that jumped backwards

      if (t < 1) { this._drawFrame(f, p, t); return; }

      p.idx++;
      if (f.kind === 'wave') p.waveNo++;
      p.frameStart += dur;
    }
    this._settlePlay();
  }

  _drawFrame(f, p, t) {
    if (!this.L) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const pulse = 0.5 + 0.5 * Math.sin(nowMs() / 480);

    if (f.kind === 'wave') {
      const prev = p.frames[p.idx - 1];
      if (t < LAND_AT) {
        // Balls still in the air: the pre-wave board, minus the tiles mid-bust.
        const hidden = new Set(f.busts.map((b) => b.at));
        drawBoard(ctx, this.L, { owner: prev.owner, count: prev.count, hidden, pulse, ...p.chrome });
      } else {
        // Touchdown: the post-wave board, with every tile that just took a ball
        // snapping up into place.
        const lt = (t - LAND_AT) / (1 - LAND_AT);
        const land = new Map();
        for (const b of f.busts) for (const target of b.to) land.set(target, lt);
        drawBoard(ctx, this.L, { owner: f.owner, count: f.count, land, pulse, ...p.chrome });
      }
      drawFlyers(ctx, this.L, f.busts, t);
    } else {
      const view = { owner: f.owner, count: f.count, pulse, ...p.chrome };
      if (f.kind === 'place' || f.kind === 'open') { view.popAt = f.at; view.popT = t; }
      drawBoard(ctx, this.L, view);
    }
  }

  /** Land the final board, drop back to idle, and resolve the play promise. */
  _settlePlay() {
    const p = this._play;
    this._play = null;
    if (!p) return;
    const last = p.frames[p.frames.length - 1];
    if (last) this.staticView = { owner: last.owner, count: last.count, ...p.chrome };
    this._mode = 'idle';
    this._stopWatchdog();
    this.renderStatic();
    this._ensureLoop();
    try { p.resolve(); } catch { /* ignore */ }
  }

  cancel() {
    const p = this._play;
    this._play = null;
    this._mode = 'stopped';
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._looping = false;
    this._stopWatchdog();
    if (p) { try { p.resolve(); } catch { /* ignore */ } }
  }
}

/* ------------------------------------------------------------------ chrome -- */

/** Tiles a player may not open on, for the placement-phase shading. */
export function blockedPlacementTiles(state) {
  if (state.phase !== PHASE_PLACE) return null;
  const legal = new Set(legalPlacements(state));
  const blocked = new Set();
  for (let i = 0; i < state.owner.length; i++) if (!legal.has(i)) blocked.add(i);
  return blocked;
}

export { neighbors };
