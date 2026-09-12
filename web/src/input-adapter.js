/**
 * BUST — web input adapter.
 *
 * Bridges the browser's native mouse/pointer + keyboard events onto the generic
 * input contract in @bust/core (see core/src/input.js). It keeps the DOM and
 * every key name here, in the shell, so the game logic in core never has to
 * know a `PointerEvent` from a `KeyboardEvent`.
 *
 * Pointer events are reduced to board-local CSS-pixel coordinates (x, y) — the
 * adapter measures the canvas — and keys are reduced to a core ACTION intent.
 * Touch surfaces already surface as pointer events in the browser, so a tap and
 * a mouse click reach the game through the same path, just as they did before.
 */

import { ACTION } from '../../core/src/index.js';

/**
 * Attach the adapter to a board <canvas>.
 *
 * @param {object} canvas   the game board canvas
 * @param {object} h        handlers
 * @param {(x:number, y:number) => void} h.onPointer  board-local tap/mouse-up
 * @param {(action:string) => void} h.onAction        a core ACTION intent
 */
export function installBoardInput(canvas, { onPointer, onAction }) {
  /* Measure the canvas and express the event in board-local CSS pixels. */
  const toBoardLocal = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const pt = ev.changedTouches ? ev.changedTouches[0] : ev;
    const x = (pt.clientX !== undefined ? pt.clientX : (pt.x || 0)) - rect.left;
    const y = (pt.clientY !== undefined ? pt.clientY : (pt.y || 0)) - rect.top;
    return { x, y };
  };

  const onPointerUp = (ev) => {
    const { x, y } = toBoardLocal(ev);
    onPointer?.(x, y);
  };

  const onKeyDown = (ev) => {
    const k = ev.key || ev.code || '';
    let action = null;
    switch (k) {
      case 'ArrowLeft':  case 'a': case 'A': action = ACTION.NAV_LEFT;  break;
      case 'ArrowRight': case 'd': case 'D': action = ACTION.NAV_RIGHT; break;
      case 'ArrowUp':    case 'w': case 'W': action = ACTION.NAV_UP;    break;
      case 'ArrowDown':  case 's': case 'S': action = ACTION.NAV_DOWN;  break;
      case 'Enter': case ' ': case 'Spacebar': action = ACTION.ACTIVATE; break;
      default: return;
    }
    ev.preventDefault();
    onAction?.(action);
  };

  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}