/**
 * BUST — iOS native config patch.
 *
 * Writes the product-level iOS settings Capacitor leaves blank, into the
 * generated project at ios/ios/App/App/Info.plist. Re-run after `cap sync ios`
 * regenerates the native project.
 *
 * Orientation: the web PWA is `orientation:any`, so the app allows all four
 * device orientations. To lock the app to portrait, delete the two
 * Landscape* strings below (or edit this template).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ios = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ios, 'ios', 'App', 'App', 'Info.plist');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<dict>
  <key>CFBundleDisplayName</key><string>BUST</string>
  <key>CFBundleIdentifier</key><string>com.bust.game</string>
  <key>CFBundleName</key><string>BUST</string>
  <!-- Orientation: allow every rotation (matches manifest "orientation": "any").
       For a portrait lock, drop the two Landscape* entries. -->
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>Portrait</string>
    <string>PortraitUpsideDown</string>
    <string>LandscapeLeft</string>
    <string>LandscapeRight</string>
  </array>
  <!-- The game is canvas-first; it runs edge-to-edge under the notch. Safe areas
       are honoured in CSS via env(safe-area-inset-*) — see ios/app.css. -->
  <key>UIRequiresFullScreen</key><false/>
</dict>
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, PLIST);
console.log('Info.plist →', target);