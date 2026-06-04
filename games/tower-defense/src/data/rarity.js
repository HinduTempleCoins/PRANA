// Rarity is a pure game-design concept (it stays in BOTH the clean and crypto builds).
//
// Trait-schema mapping note (EE2):
//   The on-chain source of truth is contracts/contracts/MutableStatNFT.sol, which stores
//     - genome   : uint256 immutable baseline (set at mint),
//     - Core      : { level (uint64), xp (uint128), wear (uint32), equippedItem (uint256) },
//     - stats     : open bytes32 => uint256 attribute store (e.g. "damage","range","fireRate").
//   CreatureNFT.sol packs everything into one uint256 `traits` word instead.
//   Neither contract has a named "rarity" enum — rarity is derived off-chain from the
//   genome/traits word. The chain loader (chainLoader.js) is responsible for that derivation;
//   the fixture just hard-codes the resulting string so the game only ever sees this shape:
//     { tokenId, name, rarity, stats:{ damage, range, fireRate, level, xp } }

export const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];

export const RARITY_COLOR = {
  Common: 0xbfbfbf,
  Uncommon: 0x4caf50,
  Rare: 0x2196f3,
  Epic: 0x9c27b0,
  Legendary: 0xffb300,
};

const FALLBACK_COLOR = 0xffffff;

export function rarityColor(rarity) {
  return RARITY_COLOR[rarity] ?? FALLBACK_COLOR;
}

// Derive a rarity bucket from a numeric genome/traits word. Deterministic; used by the
// chain loader so on-chain tokens (which carry no rarity string) get the same five buckets.
export function rarityFromGenome(genome) {
  const n = typeof genome === 'bigint' ? genome : BigInt(genome || 0);
  const bucket = Number(n % 100n);
  if (bucket >= 96) return 'Legendary'; // 4%
  if (bucket >= 86) return 'Epic'; // 10%
  if (bucket >= 66) return 'Rare'; // 20%
  if (bucket >= 36) return 'Uncommon'; // 30%
  return 'Common'; // 36%
}
