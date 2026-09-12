/**
 * BUST — generic input contract.
 *
 * The bridge between a platform's native input and the game. Core never
 * touches the DOM, a canvas, or any mouse/touch API directly. Instead each
 * shell — the browser's mouse/keyboard adapter, iOS's touch adapter — maps its
 * platform events onto the vocabulary below and feeds them to the controller.
 *
 * Pointer events carry *board-local* CSS-pixel coordinates (already translated
 * out of device space), so the core can hit-test them without knowing anything
 * about the OS. Keyboard/controller style input is expressed as intent
 * (`activate`, `nav-left`, ...) rather than raw key names.
 */

import { hitTest } from './render.js';

/**
 * What a pointer can do. `down`/`move`/`up` map 1:1 to a platform's
 * pointer/touch down, move and up — the game mostly cares about `up` (a tap
 * commits), but the full lifecycle is provided so shells that need it (drags,
 * iOS touch cancellation) have somewhere to land.
 *
 * @typedef {{ x:number, y:number, id?:string|number }} PointerEvent
 *   `x`/`y` are in CSS pixels relative to the board's top-left. `id` lets a
 *   multitouch shell keep several simultaneous pointers apart if it needs to.
 */

/** Pointer lifecycle intents the game understands. */
export const POINTER = Object.freeze({
  DOWN: 'pointer-down',
  MOVE: 'pointer-move',
  UP:   'pointer-up',
  CANCEL: 'pointer-cancel',
});

/** Non-pointer actions, mapped by the shell from keys/buttons/gestures. */
export const ACTION = Object.freeze({
  ACTIVATE: 'activate',   // commit / plan the focused tile (Enter, tap)
  CANCEL:   'cancel',     // undo an action (Esc, back)
  NAV_LEFT: 'nav-left',
  NAV_RIGHT:'nav-right',
  NAV_UP:   'nav-up',
  NAV_DOWN: 'nav-down',
});

/**
 * Turn a board-local point into a tile index, or -1 when it misses the board.
 * Pure function shells call from their adapter.
 * @param {object} L  layout from `computeLayout` / `animator.L`
 * @param {number} x  CSS px, board-local
 * @param {number} y  CSS px, board-local
 * @returns {number}
 */
export function tileFromPointer(L, x, y) {
  return hitTest(L, x, y);
}