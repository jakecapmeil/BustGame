/**
 * BUST — iOS app icon + splash generation.
 *
 * Runs Capacitor's asset generator to produce the AppIcon.appiconset and
 * SplashScreen sets from a single high-res source. `cap add ios`/`cap sync`
 * drop those sets into ios/ios/App/App. Tolerates the CLI not being installed
 * yet (first-time scaffolding), just warns.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ios = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(ios, 'Resources', 'icon-source.png');

// Provide a source icon if none exists yet: reuse the 512px web icon. Capacitor
// prefers 1024px, so instruct when this fallback is used.
if (!fs.existsSync(source)) {
  const fallback = path.join(ios, '..', 'web', 'assets', 'icon-512.png');
  if (fs.existsSync(fallback)) {
    fs.cpSync(fallback, source);
    console.log('icon-source.png: copied from web/assets/icon-512.png (Capacitor prefers 1024×1024 — drop in ios/Resources/icon-source.png for best results).');
  } else {
    console.log('No icon source at ios/Resources/icon-source.png — provide one to generate app icons.');
    process.exit(0);
  }
}

try {
  execSync('npx @capacitor/assets generate --ios', { cwd: ios, stdio: 'inherit' });
  console.log('iOS app icon + splash sets written (see ios/ios/App/App/Assets.xcassets).');
} catch {
  console.log('No icon/splash sets generated yet — run `npx @capacitor/assets generate --ios` in /ios once `npm install` has finished and the native project exists. Until then the default Capacitor icon is used.');
}