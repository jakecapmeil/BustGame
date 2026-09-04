/**
 * BUST — the neural opponent's brain.
 *
 * Runs the policy+value network trained by the companion AlphaZero project
 * (../../bustai). BatchNorm was folded into the preceding convolution at export
 * time, so this only needs convolutions, ReLU, residual adds, global pooling
 * and two dense layers — no normalisation layers to reimplement, no
 * dependencies, no build step, in keeping with the rest of the app.
 *
 * The network is fully convolutional: the policy is one logit per tile and the
 * value head pools globally, so a net trained on Duel's 7x7 board runs
 * unchanged on any other board size.
 *
 * Tensors are CHW Float32Array throughout, matching the exporter.
 */

import { EMPTY, PHASE_PLACE, legalMoves, isBlocked, outDegree } from './engine.js';

/** float16 -> float32. The weights ship as half precision to halve the download. */
function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 6.103515625e-5 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function decodeWeights(buffer, dtype, total) {
  if (dtype === 'float32') return new Float32Array(buffer, 0, total);
  const src = new Uint16Array(buffer, 0, total);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = halfToFloat(src[i]);
  return out;
}

/* ------------------------------------------------------------------- ops -- */

/**
 * 3x3 convolution, stride 1, zero padding 1.
 *
 * The source is copied once into a zero-padded buffer, then each output pixel
 * accumulates in a local so the hot loop stores once instead of nine times.
 * Two output channels are computed together because they read exactly the same
 * nine input values — on a 7x7 board the loads, not the multiplies, are what
 * this costs. Measured at roughly 2.4x the naive tap-major loop.
 */
function conv3(src, cin, h, w, weight, bias, cout, dst, pad) {
  const pw = w + 2;
  const ph = h + 2;
  const plane = h * w;
  pad.fill(0, 0, cin * ph * pw);
  for (let c = 0; c < cin; c++) {
    const s = c * plane;
    const d = c * ph * pw + pw + 1;
    for (let y = 0; y < h; y++) {
      const so = s + y * w;
      const dof = d + y * pw;
      for (let x = 0; x < w; x++) pad[dof + x] = src[so + x];
    }
  }

  const pairs = cout & ~1;
  for (let oc = 0; oc < pairs; oc += 2) {
    const ob0 = oc * plane;
    const ob1 = ob0 + plane;
    const wo0 = oc * cin * 9;
    const wo1 = wo0 + cin * 9;
    const b0 = bias[oc];
    const b1 = bias[oc + 1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a0 = b0;
        let a1 = b1;
        const p0 = y * pw + x;
        for (let ic = 0; ic < cin; ic++) {
          const w0 = wo0 + ic * 9;
          const w1 = wo1 + ic * 9;
          const pb = ic * ph * pw + p0;
          const v0 = pad[pb], v1 = pad[pb + 1], v2 = pad[pb + 2];
          const v3 = pad[pb + pw], v4 = pad[pb + pw + 1], v5 = pad[pb + pw + 2];
          const v6 = pad[pb + 2 * pw], v7 = pad[pb + 2 * pw + 1], v8 = pad[pb + 2 * pw + 2];
          a0 += weight[w0] * v0 + weight[w0 + 1] * v1 + weight[w0 + 2] * v2
              + weight[w0 + 3] * v3 + weight[w0 + 4] * v4 + weight[w0 + 5] * v5
              + weight[w0 + 6] * v6 + weight[w0 + 7] * v7 + weight[w0 + 8] * v8;
          a1 += weight[w1] * v0 + weight[w1 + 1] * v1 + weight[w1 + 2] * v2
              + weight[w1 + 3] * v3 + weight[w1 + 4] * v4 + weight[w1 + 5] * v5
              + weight[w1 + 6] * v6 + weight[w1 + 7] * v7 + weight[w1 + 8] * v8;
        }
        const at = y * w + x;
        dst[ob0 + at] = a0;
        dst[ob1 + at] = a1;
      }
    }
  }
  for (let oc = pairs; oc < cout; oc++) {   // odd channel count, if it ever happens
    const ob = oc * plane;
    const wo = oc * cin * 9;
    const b = bias[oc];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = b;
        const p0 = y * pw + x;
        for (let ic = 0; ic < cin; ic++) {
          const wb = wo + ic * 9;
          const pb = ic * ph * pw + p0;
          acc += weight[wb] * pad[pb] + weight[wb + 1] * pad[pb + 1] + weight[wb + 2] * pad[pb + 2]
               + weight[wb + 3] * pad[pb + pw] + weight[wb + 4] * pad[pb + pw + 1] + weight[wb + 5] * pad[pb + pw + 2]
               + weight[wb + 6] * pad[pb + 2 * pw] + weight[wb + 7] * pad[pb + 2 * pw + 1] + weight[wb + 8] * pad[pb + 2 * pw + 2];
        }
        dst[ob + y * w + x] = acc;
      }
    }
  }
}

/** 1x1 convolution — a per-pixel matrix multiply. */
function conv1(src, cin, plane, weight, bias, cout, dst) {
  for (let oc = 0; oc < cout; oc++) {
    const ob = oc * plane;
    dst.fill(bias[oc], ob, ob + plane);
    for (let ic = 0; ic < cin; ic++) {
      const wv = weight[oc * cin + ic];
      if (wv === 0) continue;
      const sb = ic * plane;
      for (let p = 0; p < plane; p++) dst[ob + p] += wv * src[sb + p];
    }
  }
}

function relu(a, n) {
  for (let i = 0; i < n; i++) if (a[i] < 0) a[i] = 0;
}

function addRelu(a, b, n) {
  for (let i = 0; i < n; i++) {
    const v = a[i] + b[i];
    a[i] = v < 0 ? 0 : v;
  }
}

/* ----------------------------------------------------------------- model -- */

export class BustNet {
  /**
   * @param {object} meta   parsed bust_net.json
   * @param {ArrayBuffer} buffer  bust_net.bin
   */
  constructor(meta, buffer) {
    this.meta = meta;
    this.channels = meta.channels;
    this.blocks = meta.blocks;
    this.planes = meta.planes;
    const all = decodeWeights(buffer, meta.dtype, meta.total);
    this.w = {};
    for (const l of meta.layers) {
      this.w[l.name] = all.subarray(l.offset, l.offset + l.count);
    }
    this._shape = null;
  }

  /** Allocate the scratch buffers for one board size; reused across calls. */
  _prepare(h, w) {
    if (this._shape && this._shape[0] === h && this._shape[1] === w) return;
    const ch = this.channels;
    const plane = h * w;
    this._shape = [h, w];
    this.bufA = new Float32Array(ch * plane);
    this.bufB = new Float32Array(ch * plane);
    this.bufC = new Float32Array(ch * plane);
    this.head = new Float32Array(32 * plane);
    this.head2 = new Float32Array(32 * plane);
    this.out1 = new Float32Array(plane);
    this.pad = new Float32Array(Math.max(ch, this.planes) * (h + 2) * (w + 2));
    this.pooled = new Float32Array(64);
    this.fc = new Float32Array(128);
  }

  /**
   * @param {Float32Array} input  planes, CHW, length planes*h*w
   * @returns {{logits: Float32Array, value: number}} logits alias an internal
   *   buffer and are overwritten by the next call — copy them if you keep them.
   */
  forward(input, h, w) {
    this._prepare(h, w);
    const ch = this.channels;
    const plane = h * w;
    const n = ch * plane;
    const W = this.w;

    conv3(input, this.planes, h, w, W['stem.w'], W['stem.b'], ch, this.bufA, this.pad);
    relu(this.bufA, n);

    for (let i = 0; i < this.blocks; i++) {
      conv3(this.bufA, ch, h, w, W[`block${i}_c1.w`], W[`block${i}_c1.b`], ch,
            this.bufB, this.pad);
      relu(this.bufB, n);
      conv3(this.bufB, ch, h, w, W[`block${i}_c2.w`], W[`block${i}_c2.b`], ch,
            this.bufC, this.pad);
      addRelu(this.bufA, this.bufC, n);
    }

    // policy
    conv1(this.bufA, ch, plane, W['policy_conv.w'], W['policy_conv.b'], 32, this.head);
    relu(this.head, 32 * plane);
    conv1(this.head, 32, plane, W['policy_head.w'], W['policy_head.b'], 1, this.out1);

    // value: global average and max pooling keep this size-agnostic
    conv1(this.bufA, ch, plane, W['value_conv.w'], W['value_conv.b'], 32, this.head2);
    relu(this.head2, 32 * plane);
    for (let c = 0; c < 32; c++) {
      const b = c * plane;
      let sum = 0;
      let mx = -Infinity;
      for (let p = 0; p < plane; p++) {
        const v = this.head2[b + p];
        sum += v;
        if (v > mx) mx = v;
      }
      this.pooled[c] = sum / plane;
      this.pooled[32 + c] = mx;
    }
    const w1 = W['value_fc1.w'];
    const b1 = W['value_fc1.b'];
    for (let o = 0; o < 128; o++) {
      let acc = b1[o];
      const r = o * 64;
      for (let i = 0; i < 64; i++) acc += w1[r + i] * this.pooled[i];
      this.fc[o] = acc < 0 ? 0 : acc;
    }
    const w2 = W['value_fc2.w'];
    let v = W['value_fc2.b'][0];
    for (let i = 0; i < 128; i++) v += w2[i] * this.fc[i];

    return { logits: this.out1, value: Math.tanh(v) };
  }
}

/**
 * Fetch and build a net. The weights are deliberately *not* in the service
 * worker's install list: they are close to a megabyte, and only a player who
 * actually picks the neural opponent should pay for them. The first load pulls
 * them over the network and the fetch handler's stale-while-revalidate caches
 * them, so every game after that works offline like the rest of the app.
 */
export async function loadNet(base) {
  // Resolved against this module rather than the document, so the app works
  // from a project-pages subpath without knowing what that path is.
  const dir = new URL(base || '../assets/net/', import.meta.url);
  const at = (name) => new URL(name, dir).href;
  const [metaRes, binRes] = await Promise.all([
    fetch(at('bust_net.json')),
    fetch(at('bust_net.bin')),
  ]);
  if (!metaRes.ok || !binRes.ok) {
    throw new Error(`network weights unavailable (${metaRes.status}/${binRes.status})`);
  }
  return new BustNet(await metaRes.json(), await binRes.arrayBuffer());
}

/* -------------------------------------------------------------- encoding -- */

function ownedBy(state, me) {
  const out = [];
  for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === me) out.push(i);
  return out;
}

/**
 * Board -> network input planes. Mirrors bustai/encode.py exactly; the test
 * fixture proves the two agree on real positions. Everything is written from
 * the point of view of the seat to move, so one net plays either colour.
 *
 * Planes (12):
 *   0..2   my tiles holding 1 / 2 / 3 balls
 *   3..5   opponent tiles holding 1 / 2 / 3 balls
 *   6      empty and playable
 *   7      wall
 *   8      out-degree / 4
 *   9      1 while the opening round is running
 *   10     legal-move mask for the seat to move
 *   11     all ones
 *
 * With more than two seats every opponent shares planes 3..5. The net was
 * trained on Duel, so that is a deliberate approximation in the wider modes,
 * not an oversight.
 */
export const N_PLANES = 12;

export function encode(state, legal, out, me = state.turn) {
  const n = state.owner.length;
  const buf = out || new Float32Array(N_PLANES * n);
  buf.fill(0);

  for (let i = 0; i < n; i++) {
    const o = state.owner[i];
    if (o === EMPTY) continue;
    const c = state.count[i];
    if (c < 1) continue;
    const base = (o === me ? 0 : 3) + Math.min(c, 3) - 1;
    buf[base * n + i] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (isBlocked(state, i)) buf[7 * n + i] = 1;
    else if (state.owner[i] === EMPTY) buf[6 * n + i] = 1;
    buf[8 * n + i] = outDegree(state, i) * 0.25;
  }
  if (state.phase === PHASE_PLACE) buf.fill(1, 9 * n, 10 * n);

  // `me` may not be the seat to move: nothing in the encoding says whose turn
  // it is, so a position can be scored from any seat's point of view. When it
  // is somebody else's move, plane 10 carries this seat's own tiles, which is
  // exactly what the legal mask would hold if it were their turn.
  const moves = legal
    || (me === state.turn ? legalMoves(state) : ownedBy(state, me));
  for (const m of moves) buf[10 * n + m] = 1;
  buf.fill(1, 11 * n, 12 * n);
  return buf;
}
