/**
 * BUST — the icon set.
 *
 * Everything the app draws outside the board lives here, hand-built on one
 * 24×24 grid. Nothing depends on a system emoji font: emoji size differently
 * on every platform, sit off the type baseline, ignore `color`, and can't be
 * given the flat two-tone treatment the rest of the app uses. These are plain
 * SVG strings — cheap to inline, and they inherit `currentColor`, so a rank
 * badge tints its bomb just by setting `color`.
 *
 * Two tones only, per the design language:
 *   • the silhouette in `currentColor`
 *   • cut-in detail — bands, seams, fins, plates — in SHADE, one flat black
 *     wash that reads on every rank colour without needing a second palette.
 *
 * Geometry rule: every icon is composed symmetrically about x = 12 and, where
 * the shape allows, y = 12. That is what keeps a 46px hero glyph and a 28px
 * ladder badge optically identical — no per-icon nudging anywhere in the CSS.
 */

const SHADE = 'rgba(0,0,0,.30)';

/**
 * A four-point concave spark — the app's one recurring "energy" mark. `ry`
 * defaults to `rx`; a taller-than-wide spark is what lets one sit *between*
 * two discs without its horizontal points fusing into them.
 */
const spark = (cx, cy, rx, ry = rx, fill = 'currentColor') => {
  const wx = rx * 0.30, nx = rx * 0.15;
  const wy = ry * 0.30, ny = ry * 0.15;
  return `<path d="M${cx} ${cy - ry}`
    + `C${cx + nx} ${cy - wy} ${cx + wx} ${cy - ny} ${cx + rx} ${cy}`
    + `C${cx + wx} ${cy + ny} ${cx + nx} ${cy + wy} ${cx} ${cy + ry}`
    + `C${cx - nx} ${cy + wy} ${cx - wx} ${cy + ny} ${cx - rx} ${cy}`
    + `C${cx - wx} ${cy - ny} ${cx - nx} ${cy - wy} ${cx} ${cy - ry}Z" fill="${fill}"/>`;
};

/**
 * The atomic mark: `n` crossed orbits and a nucleus, in SHADE. It is the tell
 * that a rank has crossed from chemical explosives into nuclear ones, and it
 * gains an orbit at each of the last three ranks.
 */
const atom = (cx, cy, rx, ry, n) => {
  let out = `<g fill="none" stroke="${SHADE}" stroke-width="1.25">`;
  for (let i = 0; i < n; i++) {
    const deg = (180 / n) * i;
    out += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"`
      + (deg ? ` transform="rotate(${deg} ${cx} ${cy})"` : '') + '/>';
  }
  return `${out}</g><circle cx="${cx}" cy="${cy}" r="${ry * 0.62}" fill="${SHADE}"/>`;
};

/* ------------------------------------------------------------------ ranks -- */

/**
 * The trophy ladder, drawn as a yield ladder. Each bomb is a real class of
 * ordnance and each is visibly larger in the frame than the one below it, so
 * the badges alone tell you where you are without reading a word:
 *
 *   firecracker → dynamite → grenade → shell → bombshell → airstrike
 *   → MOAB → Fat Man (fission) → hydrogen (fusion) → Tsar Bomba
 */
export const RANK_ICONS = {
  /* ~2 g of flash powder: the smallest thing in the frame. */
  firecracker: `
    <rect x="9.5" y="8.4" width="5" height="12.1" rx="1.5" fill="currentColor"/>
    <rect x="8.7" y="7.6" width="6.6" height="2.1" rx="1" fill="currentColor"/>
    <rect x="9.5" y="12.3" width="5" height="1.8" fill="${SHADE}"/>
    <rect x="9.5" y="16.4" width="5" height="1.8" fill="${SHADE}"/>
    <path d="M12.8 7.4c.5-1.9 1.8-2.7 3.4-2.9" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round"/>
    ${spark(17.4, 3.4, 2.4)}`,

  /* Three bound sticks — the first thing with a strap around it. */
  dynamite: `
    <rect x="5.4" y="7.4" width="4" height="13.2" rx="1.4" fill="currentColor"/>
    <rect x="10" y="6.6" width="4" height="14" rx="1.4" fill="currentColor"/>
    <rect x="14.6" y="7.4" width="4" height="13.2" rx="1.4" fill="currentColor"/>
    <rect x="4.6" y="11.4" width="14.8" height="2.6" rx=".9" fill="${SHADE}"/>
    <rect x="4.6" y="16.6" width="14.8" height="2.6" rx=".9" fill="${SHADE}"/>
    <path d="M12.6 6.4c.7-2 2.2-2.9 4-3.1" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round"/>
    ${spark(18, 2.2, 2.2)}`,

  /* Mk 2 fragmentation grenade: the scored body, the spoon, the pin ring. */
  grenade: `
    <ellipse cx="12" cy="14.7" rx="5.5" ry="6.2" fill="currentColor"/>
    <rect x="9.8" y="6" width="4.4" height="3.4" rx="1.1" fill="currentColor"/>
    <path d="M13.9 6.6h2.8a1.2 1.2 0 0 1 1.2 1.2v5.4" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M9.8 6.9H8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="6.7" cy="6.9" r="1.9" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <path d="M7.4 12.4h9.2M7.1 15.9h9.8M9.7 10v9.4M14.3 10v9.4"
          stroke="${SHADE}" stroke-width="1.15" stroke-linecap="round"/>`,

  /* A 155 mm artillery round: ogive nose, copper driving band, flared base. */
  shell: `
    <path d="M12 2.2c2.9 2.7 4.2 5.9 4.2 8.9v8.1H7.8v-8.1c0-3 1.3-6.2 4.2-8.9Z" fill="currentColor"/>
    <path d="M7.8 19.2h8.4l1.7 2.7H6.1Z" fill="currentColor"/>
    <rect x="7.8" y="14.8" width="8.4" height="2.3" fill="${SHADE}"/>
    <path d="M7.9 19.3h8.2" stroke="${SHADE}" stroke-width="1.2"/>
    <path d="M12 19.4v2.3M9.5 19.4l-.9 2.3M14.5 19.4l.9 2.3"
          stroke="${SHADE}" stroke-width="1.05" stroke-linecap="round"/>`,

  /* The archetypal round powder bomb — the first one that fills the frame. */
  bombshell: `
    <circle cx="11" cy="14.9" r="6.9" fill="currentColor"/>
    <rect x="8.8" y="5.4" width="4.6" height="3.6" rx="1.1" fill="currentColor"/>
    <path d="M13.2 6.3c1.9-1.2 3.5-.7 4.4.9" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"/>
    ${spark(18.9, 3.6, 2.6)}`,

  /* A Mk 84 general-purpose bomb, tipped over: the first rank that is dropped
     on you rather than thrown, so it is the only one drawn in flight. */
  airstrike: `
    <g transform="rotate(35 12 12)">
      <path d="M12 4.4c3 1.7 4.6 4.8 4.6 8.1 0 2.1-.5 3.8-1.5 4.9H8.9c-1-1.1-1.5-2.8-1.5-4.9
               0-3.3 1.6-6.4 4.6-8.1Z" fill="currentColor"/>
      <rect x="7.7" y="11.3" width="8.6" height="2" fill="${SHADE}"/>
      <path d="M9.2 17.4h5.6l2 3.5H7.2Z" fill="currentColor"/>
      <path d="M12 17.6v3.1M9.9 17.6l-1 3.1M14.1 17.6l1 3.1"
            stroke="${SHADE}" stroke-width="1" stroke-linecap="round"/>
    </g>`,

  /* GBU-43/B MOAB: blunt, enormous, and steered by a lattice of grid fins. */
  moab: `
    <path d="M12 1.8c3.3 1.4 5.5 4.6 5.5 8.2v7H6.5v-7c0-3.6 2.2-6.8 5.5-8.2Z" fill="currentColor"/>
    <path d="M7.4 7.1h9.2" stroke="${SHADE}" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="6.5" y="11.4" width="11" height="2.3" fill="${SHADE}"/>
    <rect x="4.2" y="17.1" width="15.6" height="4.7" rx="1.2" fill="currentColor"/>
    <path d="M4.2 19.45h15.6M8.5 17.1v4.7M12 17.1v4.7M15.5 17.1v4.7"
          stroke="${SHADE}" stroke-width="1.05"/>`,

  /* Fat Man: the plated implosion sphere. First rank that goes nuclear. */
  fatman: `
    <path d="M12 2c4.3 0 7.4 3.7 7.4 8.2s-2.8 7.7-7.4 7.7-7.4-3.2-7.4-7.7S7.7 2 12 2Z"
          fill="currentColor"/>
    <path d="M8.6 17.7h6.8l2.3 4.1H6.3Z" fill="currentColor"/>
    <path d="M8.5 17.8h7" stroke="${SHADE}" stroke-width="1.3"/>
    <path d="M12 17.9v3.8M9.6 17.9l-1.1 3.8M14.4 17.9l1.1 3.8"
          stroke="${SHADE}" stroke-width="1.05" stroke-linecap="round"/>
    ${atom(12, 10, 5.4, 2.3, 1)}`,

  /* A staged thermonuclear casing — megatons, and a third orbit to say so. */
  hydrogen: `
    <path d="M12 1.7c4.4 1 7.3 4.1 7.3 8v6.9H4.7V9.7c0-3.9 2.9-7 7.3-8Z" fill="currentColor"/>
    <path d="M4.1 16.5h15.8l-1.7 5.3H5.8Z" fill="currentColor"/>
    <rect x="4.8" y="15.3" width="14.4" height="1.9" fill="${SHADE}"/>
    <path d="M12 16.7v5M8.6 16.7l-1.4 5M15.4 16.7l1.4 5"
          stroke="${SHADE}" stroke-width="1.05" stroke-linecap="round"/>
    ${atom(12, 9.4, 5.6, 2.4, 2)}`,

  /* Tsar Bomba — 50 Mt, the largest device ever fired, and it wears a crown. */
  tsar: `
    <path d="M7.6 5.6 6.5 1.3a.55.55 0 0 1 .85-.58L10 2.4 11.55.75a.6.6 0 0 1 .9 0L14 2.4l2.65-1.68
             a.55.55 0 0 1 .85.58l-1.1 4.3Z" fill="currentColor"/>
    <path d="M12 4.4c4.9.8 8 3.8 8 7.6v5H4v-5c0-3.8 3.1-6.8 8-7.6Z" fill="currentColor"/>
    <path d="M2.5 17.1h19l-1.5 4.6H4Z" fill="currentColor"/>
    <rect x="4.1" y="16" width="15.8" height="2" fill="${SHADE}"/>
    <path d="M12 17.3v4.3M8.2 17.3l-1.3 4.3M15.8 17.3l1.3 4.3"
          stroke="${SHADE}" stroke-width="1.05" stroke-linecap="round"/>
    ${atom(12, 11.4, 6, 2.5, 3)}`,
};

/* ------------------------------------------------------------------ modes -- */

/**
 * Mode marks. Each one is a diagram of the match it starts — seats as discs,
 * the board as a frame, walls as blocks — rather than a decorative symbol, so
 * the picker reads at a glance.
 */
export const MODE_ICONS = {
  /* Two seats, one flashpoint. */
  duel: `
    <circle cx="4.9" cy="12" r="4.1" fill="currentColor"/>
    <circle cx="19.1" cy="12" r="4.1" fill="currentColor"/>
    ${spark(12, 12, 2.3, 5.4)}`,

  /* Four seats, no allies: everyone facing the middle. */
  rumble: `
    <circle cx="12" cy="4.7" r="3.5" fill="currentColor"/>
    <circle cx="19.3" cy="12" r="3.5" fill="currentColor"/>
    <circle cx="12" cy="19.3" r="3.5" fill="currentColor"/>
    <circle cx="4.7" cy="12" r="3.5" fill="currentColor"/>
    ${spark(12, 12, 2.9)}`,

  /* The same four, pushed out to the corners of a bigger board. */
  arena: `
    <rect x="2.3" y="2.3" width="19.4" height="19.4" rx="4.6" fill="none"
          stroke="currentColor" stroke-width="2"/>
    <circle cx="7.9" cy="7.9" r="2.6" fill="currentColor"/>
    <circle cx="16.1" cy="7.9" r="2.6" fill="currentColor"/>
    <circle cx="7.9" cy="16.1" r="2.6" fill="currentColor"/>
    <circle cx="16.1" cy="16.1" r="2.6" fill="currentColor"/>`,

  /* Eight seats ringing one detonation. */
  mayhem: `
    <circle cx="12" cy="3.8" r="2.3" fill="currentColor"/>
    <circle cx="17.8" cy="6.2" r="2.3" fill="currentColor"/>
    <circle cx="20.2" cy="12" r="2.3" fill="currentColor"/>
    <circle cx="17.8" cy="17.8" r="2.3" fill="currentColor"/>
    <circle cx="12" cy="20.2" r="2.3" fill="currentColor"/>
    <circle cx="6.2" cy="17.8" r="2.3" fill="currentColor"/>
    <circle cx="3.8" cy="12" r="2.3" fill="currentColor"/>
    <circle cx="6.2" cy="6.2" r="2.3" fill="currentColor"/>
    ${spark(12, 12, 3.6)}`,

  /* Two pairs, each bound together, meeting in the middle. */
  duos: `
    <circle cx="5.4" cy="7" r="3.4" fill="currentColor"/>
    <circle cx="5.4" cy="17" r="3.4" fill="currentColor"/>
    <rect x="3.9" y="7" width="3" height="10" fill="currentColor"/>
    <circle cx="18.6" cy="7" r="3.4" fill="currentColor"/>
    <circle cx="18.6" cy="17" r="3.4" fill="currentColor"/>
    <rect x="17.1" y="7" width="3" height="10" fill="currentColor"/>
    ${spark(12, 12, 2.4, 5.2)}`,

  /* A mirrored maze — literally the shape `makeWalls` deals out. */
  chaos: `
    <rect x="2.4" y="3" width="4.4" height="8.6" rx="1.4" fill="currentColor"/>
    <rect x="9" y="2.6" width="8.6" height="4.4" rx="1.4" fill="currentColor"/>
    <rect x="17.2" y="12.4" width="4.4" height="8.6" rx="1.4" fill="currentColor"/>
    <rect x="6.4" y="17" width="8.6" height="4.4" rx="1.4" fill="currentColor"/>
    <circle cx="12" cy="12" r="3.2" fill="currentColor"/>`,

  /* Your rules: three sliders, none of them where the defaults left them. */
  custom: `
    <rect x="2.5" y="4.6" width="19" height="3.4" rx="1.7" fill="${SHADE}"/>
    <rect x="2.5" y="10.3" width="19" height="3.4" rx="1.7" fill="${SHADE}"/>
    <rect x="2.5" y="16" width="19" height="3.4" rx="1.7" fill="${SHADE}"/>
    <circle cx="8.2" cy="6.3" r="3.2" fill="currentColor"/>
    <circle cx="15.6" cy="12" r="3.2" fill="currentColor"/>
    <circle cx="11" cy="17.7" r="3.2" fill="currentColor"/>`,
};

/* --------------------------------------------------------------------- ui -- */

/** Chrome: the trophy, and the handful of glyphs the shell used to borrow. */
export const UI_ICONS = {
  /**
   * The trophy. A cup, built to the same extruded proportions as the buttons —
   * heavy foot, thick rim — with a blast spark struck into the bowl so the
   * award and the ordnance read as one family.
   */
  trophy: `
    <path d="M6.6 4.4H3.5v2.3c0 2.5 1.9 4.6 4.4 5" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round"/>
    <path d="M17.4 4.4h3.1v2.3c0 2.5-1.9 4.6-4.4 5" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round"/>
    <path d="M5.7 3.6h12.6v5.2c0 3.5-2.8 6.3-6.3 6.3S5.7 12.3 5.7 8.8V3.6Z" fill="currentColor"/>
    <rect x="4.6" y="1.9" width="14.8" height="2.5" rx="1.1" fill="currentColor"/>
    <rect x="10.5" y="14.6" width="3" height="3.2" fill="currentColor"/>
    <rect x="7.4" y="17.4" width="9.2" height="2.1" rx=".9" fill="currentColor"/>
    <rect x="5.3" y="19.4" width="13.4" height="2.5" rx="1.2" fill="currentColor"/>
    ${spark(12, 8.6, 3.5, 3.5, SHADE)}`,

  back: `<path d="M14.8 5.2 8 12l6.8 6.8" fill="none" stroke="currentColor" stroke-width="2.6"
              stroke-linecap="round" stroke-linejoin="round"/>`,

  menu: `<path d="M4.6 7.4h14.8M4.6 12h14.8M4.6 16.6h14.8" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round"/>`,

  check: `<path d="M4.8 12.6 9.6 17.4 19.2 6.8" fill="none" stroke="currentColor"
                stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,

  rise: `<path d="M12 19V6.4M6.4 11.6 12 5.8l5.6 5.8" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/* ------------------------------------------------------------------ render -- */

const ALL = { ...UI_ICONS, ...MODE_ICONS, ...RANK_ICONS };

/**
 * An icon as an inline `<svg>` string. Sized by its container, never by a font
 * size, which is what finally makes every mark land dead centre in its box.
 *
 * @param {string} name  key in UI_ICONS / MODE_ICONS / RANK_ICONS
 * @param {string} [cls] extra class on the svg element
 */
export function icon(name, cls = '') {
  const body = ALL[name];
  if (!body) return '';
  return `<svg class="ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" `
    + `focusable="false" aria-hidden="true">${body}</svg>`;
}

/** Shorthands, so callers don't have to know which map a name came from. */
export const rankIcon = (key) => icon(key);
export const modeIcon = (key) => icon(key);

/**
 * Fill every `<span data-icon="name">` under `root`. Static chrome declares its
 * icon in the markup and this paints it once on boot; dynamic views call
 * `icon()` directly.
 */
export function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.dataset.icon;
    if (name && el.firstElementChild?.tagName !== 'svg') el.innerHTML = icon(name);
  });
}
