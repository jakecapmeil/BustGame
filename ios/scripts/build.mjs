/**
 * BUST — iOS bundle.
 *
 * Assembles ios/www, the webDir Capacitor serves from the native app:
 *   - the SAME presentation as /web (index.html, styles.css, icons)
 *   - core + the web controller bundled by esbuild into a single app.js
 *   - the ios/src bootstrap (touch adapter + Haptics bridge) as the entry
 *   - the neural weights (assets/net) so the Neural rung works offline
 *
 * webDir is ios/www (NOT web/dist) so the web deploy stays an unbundled,
 * esbuild-free static site and the iOS shell carries its own production bundle.
 */

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ios = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(ios, '..');
const web = path.join(repo, 'web');
const core = path.join(repo, 'core');
const www = path.join(ios, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

// 1) Static presentation, reused from /web (single source of truth).
fs.cpSync(path.join(web, 'index.html'), path.join(www, 'index.html'));
fs.cpSync(path.join(web, 'styles.css'), path.join(www, 'styles.css'));
fs.cpSync(path.join(web, 'manifest.webmanifest'), path.join(www, 'manifest.webmanifest'));
fs.cpSync(path.join(web, 'assets'), path.join(www, 'assets'), { recursive: true });

// iOS-only presentation: board touch-action (stops double-commit), safe areas,
// orientation handling (see app.css).
fs.cpSync(path.join(ios, 'app.css'), path.join(www, 'app.css'));

// 2) Neural weights, bundled so the top rung works offline.
fs.cpSync(path.join(core, 'assets', 'net'), path.join(www, 'assets', 'net'), { recursive: true });

// 3) Point index.html at the iOS entry instead of the raw module tree.
let html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
html = html.replace('src="src/main.js"', 'src="app.js"')
           .replace('href="styles.css">', 'href="styles.css">\n<link rel="stylesheet" href="app.css">');
fs.writeFileSync(path.join(www, 'index.html'), html);

// 4) Bundle core + web controller + ios bootstrap into app.js.
esbuild.buildSync({
  entryPoints: [path.join(ios, 'src', 'app.js')],
  bundle: true,
  outfile: path.join(www, 'app.js'),
  format: 'esm',
  platform: 'browser',
  // Modern Safari (iOS 16+) — supports top-level await and es2022 features.
  target: ['es2022'],
  sourcemap: true,
});

console.log('ios bundle →', www);