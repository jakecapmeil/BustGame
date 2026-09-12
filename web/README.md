# BUST — web / PWA (`/web`)

The thin platform shell. It restores the original single-page game exactly, but
the rules + canvas rendering now live in `/core` (@bust/core). This directory
keeps every DOM/mouse/browser concern: screens, menus, HUD, overlays, the
mouse/keyboard input adapter, localStorage, WebAudio and PeerJS.

```
web/
  index.html, styles.css   the game UI (unchanged behaviour)
  sw.js, manifest.webmanifest
  wrangler.jsonc           Cloudflare deploy config (assets.directory: ./dist)
  src/
    main.js                presentation controller (imports @bust/core by
                           relative path so the site still ships as static files)
    input-adapter.js       mouse/keyboard → core generic input events
    icons.js, audio.js, net.js
  scripts/build.mjs        assembles web/dist (web public files + resolved core)
  dist/                    (generated) what Cloudflare serves
```

The iOS app re-uses this same `main.js` + HTML/CSS (see `/ios`); it only swaps
the input adapter, haptics and output bundle.

## Run locally

```bash
npm install
npm run dev:web        # builds dist/ then `wrangler dev` (serves ./dist)
npm run serve:web      # build + python3 no-cache server
```

## Deploy (Cloudflare)

```bash
npm run deploy:web     # builds dist/ then `wrangler deploy`
```

`wrangler.jsonc` serves `./dist` (an assets-only Worker — no build step at
request time; it's a static copy, not a bundler).

## Offline

`sw.js` precaches the shell + the resolved core modules. The Neural weights
(`core/assets/net`) stay out of the install list by design (≈1 MB, only needed
for the top rung); the fetch handler stale-while-revalidates them on first use.