/**
 * BUST — web deploy bundle.
 *
 * Assembles web/dist, the self-contained static tree Cloudflare serves:
 *   - every /web public file (index.html, styles.css, sw.js, manifest, icons)
 *   - the web shell's src/
 *   - a resolved copy of /core so the relative import `../../core/...` inside
 *     src/main.js resolves *inside* the artifact.
 *
 * This is deliberately a copy step, not a bundler: the site stays a set of
 * plain ES modules with no build step, exactly as the original deployed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(web, '..');
const dist = path.join(web, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1) Only the /web files a browser actually requests. Tooling (scripts, this
//    dir, devserver, package.json, wrangler.jsonc) stays out of the upload.
for (const name of ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'assets', 'src']) {
  fs.cpSync(path.join(web, name), path.join(dist, name), { recursive: true });
}

// 2) Resolve /core into the served tree: the DOM-free source modules and the
//    neural weights. Source shuffles no build step — src/main.js imports
//    `../../core/src/...`, which resolves inside dist exactly as in-repo.
fs.cpSync(path.join(repo, 'core', 'src'), path.join(dist, 'core', 'src'), { recursive: true });
fs.cpSync(path.join(repo, 'core', 'assets'), path.join(dist, 'core', 'assets'), { recursive: true });

console.log('web build →', dist);