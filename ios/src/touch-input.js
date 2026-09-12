/**
 * BUST — iOS touch input adapter.
 *
 * Maps the platform's native touch events onto the *generic* input contract in
 * @bust/core (see core/src/input.js) — the same shape the web shell's
 * mouse/keyboard adapter produces. Core never sees a TouchEvent.
 *
 * A tap is a "pointer up" in board-local CSS pixels (exactly what the game's
 * `handleBoardPointer` expects), so one tap commits one tile. The handlers call
 * `preventDefault()` and the stylesheet sets `touch-action: none` on the board,
 * which together stop the WebView synthesizing a second pointer/mouse event
 * from the same tap (which would otherwise double-commit).
 */

/** @type {Map<number, {x:number,y:number}>} tracked pointers (multitouch-safe). */
const touches = new Map();

function toBoardLocal(canvas, t) {
  const rect = canvas.getBoundingClientRect();
  return { x: (t.clientX - rect.left), y: (t.clientY - rect.top) };
}

/**
 * Attach the touch adapter to a board <canvas>.
 * @param {object} canvas  the game board canvas (in the Capacitor WebView)
 * @param {object} h       handlers, same shape as the web adapter
 * @param {(x:number,y:number)=>void} h.onPointer
 * @param {(action:string)=>void} h.onAction
 */
export function installTouchInput(canvas, { onPointer, onAction }) {
  canvas.addEventListener('touchstart', (ev) => {
    ev.preventDefault(); // suppress synthetic pointer/mouse events
    for (const t of ev.changedTouches) touches.set(t.id, toBoardLocal(canvas, t));
  }, { passive: false });

  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    for (const t of ev.changedTouches) touches.set(t.id, toBoardLocal(canvas, t));
  }, { passive: false });

  canvas.addEventListener('touchend', (ev) => {
    ev.preventDefault();
    for (const t of ev.changedTouches) {
      const p = toBoardLocal(canvas, t);
      touches.delete(t.id);
      onPointer?.(p.x, p.y);
    }
  }, { passive: false });

  canvas.addEventListener('touchcancel', (ev) => {
    ev.preventDefault();
    for (const t of ev.changedTouches) touches.delete(t.id);
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}