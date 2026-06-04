// EE2 — data layer.
//
// The game consumes ONLY this canonical tower shape:
//   { tokenId, name, rarity, stats: { damage, range, fireRate, level, xp } }
// which deliberately MIRRORS the NFT trait schema (see rarity.js for the on-chain mapping).
// Because the game touches nothing else, swapping fixture -> chain later is purely a loader
// change (see chainLoader.js), not a game change.

import fixture from '../../data/towers.fixture.json' with { type: 'json' };
import { RARITIES } from './rarity.js';

const REQUIRED_STAT_KEYS = ['damage', 'range', 'fireRate', 'level', 'xp'];

// Validate + normalize a single record into the canonical shape. Throws on malformed input
// so a bad fixture/chain payload fails loudly rather than corrupting gameplay silently.
export function normalizeTower(raw, index = 0) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tower[${index}] is not an object`);
  }
  const stats = raw.stats ?? {};
  for (const key of REQUIRED_STAT_KEYS) {
    if (typeof stats[key] !== 'number' || Number.isNaN(stats[key])) {
      throw new Error(`tower[${index}] missing numeric stats.${key}`);
    }
  }
  const rarity = RARITIES.includes(raw.rarity) ? raw.rarity : 'Common';
  return {
    tokenId: Number(raw.tokenId ?? index),
    name: String(raw.name ?? `Tower #${raw.tokenId ?? index}`),
    rarity,
    stats: {
      damage: stats.damage,
      range: stats.range,
      fireRate: stats.fireRate, // shots per second
      level: stats.level,
      xp: stats.xp,
    },
  };
}

export function normalizeTowers(list) {
  if (!Array.isArray(list)) throw new Error('tower list must be an array');
  return list.map((raw, i) => normalizeTower(raw, i));
}

// Default loader: the bundled fixture. Async to match the chain loader's signature so
// callers can swap one for the other without changes.
export async function loadTowersFromFixture() {
  return normalizeTowers(fixture);
}
