/**
 * BUST — iOS bootstrap.
 *
 * Sets the platform bridges the shared code expects, then runs the SAME web
 * presentation controller (@bust/web's src/main.js) untouched. iOS provides:
 *   - a touch input adapter (instead of the desktop mouse/keyboard one)
 *   - a Capacitor Haptics bridge (Nest – Vibrate, iOS 17+; off before that)
 *   - an absolute base for the neural weights bundled into ios/www
 *
 * The HTML/CSS/controller are all reused from /web; only these platform seams
 * differ.
 */

// 1) Touch input. The web controller reads `globalThis.__BUST_INPUT__.install`
//    and calls it with its { onPointer, onAction } handlers.
import { installTouchInput } from './touch-input.js';
globalThis.__BUST_INPUT__ = { install: installTouchInput };

// 2) Neural weights are bundled at www/assets/net; pin their absolute URL so the
//    path survives bundling (import.meta.url no longer points at the source).
globalThis.__BUST_NET_BASE__ = new URL('./assets/net/', document.baseURI).href; // eslint-disable-line

// 3) Haptics bridge. `audio.buzz()` calls this when present. Capacitor Haptics
//    requires iOS 17 + a supporting device; anything else no-ops gracefully.
globalThis.__BUST_HAPTIC__ = (ms) => {
  try {
    // Dynamic import keeps the bundle loadable even if the plugin isn't
    // registered on the native side yet.
    import('@capacitor/haptics').then(({ Haptics, HapticsType }) => {
      Haptics.vibrate(ms, { type: HapticsType.Click });
    }).catch(() => { /* no haptics on this device */ });
  } catch { /* ignore */ }
};

// 4) Run the shared controller (bundled by scripts/build.mjs).
await import('../../web/src/main.js');