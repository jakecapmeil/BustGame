# BUST — iOS app (`/ios`)

A Capacitor shell around the shared game. It re-uses the **same** HTML/CSS
presentation controller from `/web` and bundles `/core` + a touch input adapter
into **`ios/www`** (this is the Capacitor `webDir`). Swap in your own Input/audio/
net/storage seams without touching core.

Layout:

```
ios/
  capacitor.config.json   appId, appName, webDir: ./www
  src/
    app.js                iOS bootstrap: touch adapter + Haptics bridge, then runs
                          the shared web controller untouched
    touch-input.js        touch → @bust/core generic input events
  scripts/
    build.mjs             esbuild bundle → ios/www (+ static web reuse)
    assets.mjs            best-effort AppIcon + Splash generation
    iospatch.mjs          writes Info.plist (orientation, app metadata)
  app.css                 iOS-only: board touch-action, safe areas, motion
  www/                    (generated) the bundle Capacitor serves
  ios/                    (generated) the native Xcode project
```

## Prerequisites

- macOS with **Full Xcode** (the GUI app; `xcode-select` must point at
  `/Applications/Xcode.app/...`, **not** `/Library/Developer/CommandLineTools`).
- Apple ID. Free is enough for the **iOS Simulator** and installing on your own
  phone. A **paid Apple Developer Program membership ($99/yr)** is required for
  **TestFlight** (distribution to >100 friends) and **App Store submission**.
- Node + npm at the repo root already (workspaces).

## Build the bundle

At the repo root:

```bash
npm install            # wires /core,/web,/ios workspaces + installs deps once
npm run build:ios      # esbuild → ios/www (reused web presentation + core + touch adapter)
```

## Create / open the native Xcode project (once)

First time:

```bash
npm run sync:ios       # `cap sync ios` → generates ios/ios/, registers plugins
npm run init:ios       # (optional shortcut: build + `cap add ios` + Info.plist)
```

(The repository does **not** store the generated `ios/ios/` project — it is
recreated by `cap sync ios` from `ios/www` + `capacitor.config.json`.)

## Run in the Xcode iOS Simulator

```bash
npm run open:ios       # opens ios/ios/App/App.xcworkspace in Xcode
```

Then in Xcode, **Product ▸ Run** (⌘R), or from the CLI:

```bash
cd ios && npx cap run ios
```

The Xcode **device target** dropdown lets you pick a simulator (e.g.
"iPhone 15 Pro") or a connected physical device. The app boots straight off
`ios/www`.

> Note: first launch is slow because Xcode compiles the Capacitor native glue.
> Subsequent runs are incremental.

## App icon + splash

Drop a 1024×1024 `ios/Resources/icon-source.png` (the build copies the web icon
as a fallback) and regenerate:

```bash
(cd ios && npx @capacitor/assets generate --ios)
npm run sync:ios
```

This writes `ios/ios/App/App/Assets.xcassets/AppIcon.appiconset` and the splash
`Assets.xcassets/SplashScreen.imageset`. `scripts/iospatch.mjs` re-applies
`Info.plist` after each `cap sync`.

## What the iPhone still needs an Apple account for

| Activity                            | Requires                                  |
|-------------------------------------|-------------------------------------------|
| iOS Simulator / local Xcode run     | free Apple ID                             |
| Install on your own phone (7-day)   | free Apple ID (sideload, developer mode)  |
| TestFlight (share w/ ≤100 testers)  | **paid** Developer membership ($99/yr)    |
| App Store distribution              | **paid** Developer membership + review    |
| Automatically renewable/local certs | Developer membership (free is OK for dev) |

Hungry for the exact distribution path later: enable Developer Mode on the
device Settings ▸ Privacy ▸ Developer Mode, run from Xcode, or use a free
sideload via USB for personal testing.