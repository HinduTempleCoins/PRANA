// Skin (cosmetic) data layer.
//
// A "skin" is a spirit palette + face-shape variant. The shape DELIBERATELY MIRRORS an
// on-chain cosmetic item from contracts/contracts/ItemRegistry.sol, whose id-range
// convention reserves 30_000 .. max for cosmetics (COSMETIC_MINTER_ROLE). So a skin maps
// 1:1 onto an ItemRegistry cosmetic id and can later be ownership-gated by the wallet hook.
//
// Canonical skin shape (the ONLY thing the game reads):
//   { itemId, name, face, palette: { spirit, accent, lantern } }
//     - itemId  : ItemRegistry cosmetic id, MUST be >= 30_000 (the cosmetics range).
//     - face    : spirit face-shape variant key ('round' | 'wisp'), purely visual.
//     - palette : `spirit` glow body -> `accent` core -> `lantern` (the friendly-spirit hue,
//                 the one you must NOT bop). Dark-field / bright-core motif throughout.
//
// ON-CHAIN OWNERSHIP GATING (documented seam, NOT implemented here):
//   The clean build ships every skin as freely selectable. In the crypto build, the
//   (private) wallet workspace will inject the player's owned cosmetic ids (read from
//   ItemRegistry.balanceOf(player, itemId) over RPC) and `ownedSkins()` will filter the
//   catalog to those the player holds. Until that hook lands, all skins are unlocked.

import fixture from '../../data/skins.fixture.json' with { type: 'json' };

// ItemRegistry cosmetics range floor (mirrors ItemRegistry.COSMETIC_MIN).
export const COSMETIC_MIN = 30000;

export const FACE_SHAPES = ['round', 'wisp'];

const PALETTE_KEYS = ['spirit', 'accent', 'lantern'];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Validate + normalize one record into the canonical skin shape. Throws on malformed
// input so a bad fixture/chain payload fails loudly rather than corrupting the menu.
export function normalizeSkin(raw, index = 0) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`skin[${index}] is not an object`);
  }
  const itemId = Number(raw.itemId);
  if (!Number.isInteger(itemId) || itemId < COSMETIC_MIN) {
    throw new Error(`skin[${index}] itemId ${raw.itemId} is not in the cosmetics range (>= ${COSMETIC_MIN})`);
  }
  const palette = raw.palette ?? {};
  for (const key of PALETTE_KEYS) {
    if (typeof palette[key] !== 'string' || !HEX.test(palette[key])) {
      throw new Error(`skin[${index}] palette.${key} must be a #rrggbb hex string`);
    }
  }
  const face = FACE_SHAPES.includes(raw.face) ? raw.face : 'round';
  return {
    itemId,
    name: String(raw.name ?? `Skin #${itemId}`),
    face,
    palette: { spirit: palette.spirit, accent: palette.accent, lantern: palette.lantern },
  };
}

export function normalizeSkins(list) {
  if (!Array.isArray(list)) throw new Error('skin list must be an array');
  return list.map((raw, i) => normalizeSkin(raw, i));
}

// Convert a "#rrggbb" string to a 0xRRGGBB integer (Phaser color form).
export function hexToInt(hex) {
  return parseInt(hex.replace(/^#/, ''), 16);
}

// Default catalog loader: the bundled fixture. Async to match a future chain loader's
// signature so callers can swap one for the other without changes.
export async function loadSkins() {
  return normalizeSkins(fixture);
}

// Ownership filter seam. Today: returns the full catalog (everything unlocked). When the
// wallet hook injects `ownedIds`, this will restrict the catalog to held cosmetics.
export function ownedSkins(catalog, ownedIds = null) {
  if (!ownedIds) return catalog;
  const set = new Set(ownedIds.map(Number));
  return catalog.filter((s) => set.has(s.itemId));
}
