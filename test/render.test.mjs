/**
 * BoardAnimator playback tests.
 *
 * Regression cover for the cascade-freeze bug: `play()` must always resolve —
 * on the final frame, and when `cancel()` interrupts it — no matter how the
 * idle loop and the animation loop interleave. Runs headless with a fake rAF
 * clock and a no-op canvas.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* -- headless environment -------------------------------------------------- */

let clock = 0;
let queue = [];
let nextHandle = 1;

globalThis.requestAnimationFrame = (cb) => {
  const h = nextHandle++;
  queue.push({ h, cb });
  return h;
};
globalThis.cancelAnimationFrame = (h) => { queue = queue.filter((e) => e.h !== h); };
globalThis.performance = { now: () => clock };
globalThis.window = { devicePixelRatio: 1 };

/** Run up to `maxFrames` animation frames, advancing the clock `dt` ms each. */
function runFrames(dt = 16, maxFrames = 5000) {
  let n = 0;
  while (queue.length && n < maxFrames) {
    const batch = queue;
    queue = [];
    clock += dt;
    for (const { cb } of batch) cb(clock);
    n++;
  }
  return n;
}

// Each test gets a clean clock and an empty frame queue, so a prior test's
// idle loop can't leak pending callbacks into the next one.
beforeEach(() => { clock = 0; queue = []; nextHandle = 1; });

const noopCtx = new Proxy({}, { get: () => () => {} });
function fakeCanvas() {
  return { width: 0, height: 0, style: {}, getContext: () => noopCtx };
}

const { BoardAnimator } = await import('../src/render.js');

function makeAnimator() {
  const a = new BoardAnimator(fakeCanvas());
  a.resize(375, 700, 5, 5);
  a.setView({ owner: new Int8Array(25).fill(-1), count: new Uint8Array(25) });
  return a;
}

/** A minimal frame script shaped like engine.applyMove output. */
function frameScript(waves = 1) {
  const owner = new Int8Array(25).fill(-1);
  const count = new Uint8Array(25);
  const frames = [{ kind: 'open', at: 6, player: 0, busts: [], owner: owner.slice(), count: count.slice() }];
  for (let w = 0; w < waves; w++) {
    frames.push({
      kind: 'wave',
      busts: [{ at: 6 + w, player: 0, to: [1, 5, 7, 11] }],
      owner: owner.slice(), count: count.slice(),
    });
  }
  return frames;
}

/* -- tests --------------------------------------------------------------- */

test('play() resolves after a single-wave script', async () => {
  const a = makeAnimator();
  let done = false;
  const p = a.play(frameScript(1), {}, null).then(() => { done = true; });
  runFrames();
  await p;
  assert.equal(done, true);
});

test('play() resolves for a long cascade (20 waves)', async () => {
  const a = makeAnimator();
  const p = a.play(frameScript(20));
  runFrames();
  await p;
  assert.equal(a._mode, 'idle', 'drops back to the idle loop when finished');
});

test('onEvent fires once per frame, in order', async () => {
  const a = makeAnimator();
  const seen = [];
  const p = a.play(frameScript(3), {}, (e) => seen.push(e.type));
  runFrames();
  await p;
  assert.deepEqual(seen, ['open', 'wave', 'wave', 'wave']);
});

test('starting a new play() settles the previous promise', async () => {
  const a = makeAnimator();
  let firstResolved = false;
  const first = a.play(frameScript(50)).then(() => { firstResolved = true; });
  runFrames(16, 2); // let it get a couple of frames in, mid-cascade
  const second = a.play(frameScript(1));
  await first;
  assert.equal(firstResolved, true, 'the abandoned playback still resolves');
  runFrames();
  await second;
});

test('cancel() resolves an in-flight play()', async () => {
  const a = makeAnimator();
  let resolved = false;
  const p = a.play(frameScript(100)).then(() => { resolved = true; });
  runFrames(16, 3);
  a.cancel();
  await p;
  assert.equal(resolved, true);
  assert.equal(queue.length, 0, 'no rAF loop left running after cancel');
});

test('idle loop and play do not leave two rAF loops running', async () => {
  const a = makeAnimator();
  a.startIdle();
  runFrames(16, 3);
  const p = a.play(frameScript(2));
  runFrames();
  await p;
  // Exactly one pending callback: the idle loop. Not two.
  assert.equal(queue.length, 1, `expected a single idle rAF, got ${queue.length}`);
  a.stopIdle();
  assert.equal(queue.length, 0);
});

test('playback still finishes when rAF never fires (tab hidden)', async () => {
  // Real wall clock, and we deliberately never pump the fake rAF queue —
  // only the watchdog interval can carry this to completion.
  const realNow = () => Date.now();
  globalThis.performance = { now: realNow };
  try {
    const a = makeAnimator();
    let resolved = false;
    const p = a.play(frameScript(4)).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(resolved, true, 'watchdog drove playback to completion');
    await p;
  } finally {
    globalThis.performance = { now: () => clock };
  }
});

test('a zero clock delta cannot wedge playback', async () => {
  const a = makeAnimator();
  const p = a.play(frameScript(2));
  runFrames(0, 50);   // time never advances...
  runFrames(16);      // ...then it does; must still finish
  await p;
  assert.equal(a._mode, 'idle');
});
