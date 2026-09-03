/**
 * Icon-set tests.
 *
 * The icons are data the rest of the app looks up by key — a rank's `key`, a
 * mode's `icon` — so the failure mode is silent: a renamed rank paints an empty
 * badge and nothing throws. These lock the two maps together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RANK_ICONS, MODE_ICONS, UI_ICONS, icon } from '../src/icons.js';
import { RANKS } from '../src/rank.js';
import { MODES, MODE_ORDER } from '../src/modes.js';

test('every rank has an icon, and there are no orphans', () => {
  for (const r of RANKS) assert.ok(RANK_ICONS[r.key], `rank ${r.key} has no icon`);
  assert.equal(Object.keys(RANK_ICONS).length, RANKS.length, 'unused rank icon');
});

test('every mode has an icon, and there are no orphans', () => {
  for (const key of MODE_ORDER) {
    assert.ok(MODE_ICONS[MODES[key].icon], `mode ${key} has no icon`);
  }
  assert.equal(Object.keys(MODE_ICONS).length, MODE_ORDER.length, 'unused mode icon');
});

test('icon() wraps a body in a 24x24 svg and is inert for unknown names', () => {
  const svg = icon('trophy');
  assert.match(svg, /^<svg class="ico" viewBox="0 0 24 24"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(icon('no-such-icon'), '');
});

test('icon() applies an extra class without dropping the base one', () => {
  assert.match(icon('trophy', 'ico-inline'), /class="ico ico-inline"/);
});

test('no icon smuggles in an emoji or a text glyph', () => {
  // The whole point of the set is that nothing depends on a system font.
  for (const [name, body] of Object.entries({ ...RANK_ICONS, ...MODE_ICONS, ...UI_ICONS })) {
    assert.ok(!/<text|[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}]/u.test(body), `${name} is not pure geometry`);
  }
});

test('every icon is balanced markup that stays inside the 24x24 box', () => {
  for (const [name, body] of Object.entries({ ...RANK_ICONS, ...MODE_ICONS, ...UI_ICONS })) {
    const opens = (body.match(/<(?!\/)[a-z]/g) || []).length;
    const closes = (body.match(/\/>|<\/[a-z]/g) || []).length;
    assert.equal(opens, closes, `${name} has unbalanced tags`);

    // A NaN in path data renders nothing and only shows up as a console error
    // in a real browser — exactly the kind of slip a helper's signature change
    // introduces silently.
    assert.ok(!/NaN|undefined/.test(body), `${name} has a bad coordinate`);

    // Absolute anchors only — path data is full of relative deltas, which say
    // nothing about where a shape sits. A misplaced anchor is the typo that
    // would push a mark off-centre in its badge.
    for (const m of body.matchAll(/\b(?:x|y|cx|cy|width|height)="(-?[\d.]+)"/g)) {
      const v = Number(m[1]);
      assert.ok(v >= 0 && v <= 24, `${name} anchors outside the grid: ${m[0]}`);
    }
    for (const m of body.matchAll(/M\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
      assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 24, `${name} starts off-grid: ${m[0]}`);
      assert.ok(Number(m[2]) >= 0 && Number(m[2]) <= 24, `${name} starts off-grid: ${m[0]}`);
    }
  }
});
