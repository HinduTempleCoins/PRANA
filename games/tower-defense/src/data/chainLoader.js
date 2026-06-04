// EE3 — optional wallet/NFT hook (loosely coupled; NO ethers dependency).
//
// This module fetches a player's owned tower NFTs straight over JSON-RPC using `fetch`,
// with hand-encoded function selectors, and maps them onto the SAME canonical tower shape
// the fixture produces (see towers.js). It ALWAYS falls back to the fixture when:
//   - this is the clean build (CRYPTO_BUILD === false), or
//   - no RPC url / contract / owner is configured, or
//   - any RPC call fails / the chain is unreachable.
//
// Where the real wallet lives: the signing wallet, key management and the user-facing
// "connect wallet" UX live in the SEPARATE (private) wallet workspace. The game stays
// read-only and loosely coupled — it only ever reads public view functions over RPC and
// never holds a key. Wiring is: wallet workspace -> sets CHAIN.{rpcUrl,nftAddress,
// ownerAddress} in config.js (or via build-time injection) -> this loader reads them.

import { CRYPTO_BUILD, CHAIN } from '../config.js';
import { loadTowersFromFixture, normalizeTower } from './towers.js';
import { rarityFromGenome } from './rarity.js';

// --- minimal ABI encoding (selectors precomputed; see comments) ------------------------ //
// 4-byte selectors = first 4 bytes of keccak256("signature"). Precomputed so we ship no
// hashing/abi library in the game bundle.
const SELECTORS = {
  // balanceOf(address) -> uint256
  balanceOf: '0x70a08231',
  // tokenOfOwnerByIndex(address,uint256) -> uint256   (ERC721Enumerable)
  tokenOfOwnerByIndex: '0x2f745c59',
  // genomeOf(uint256) -> uint256   (MutableStatNFT)
  genomeOf: '0xa6f9f5fd',
  // getCore(uint256) -> (uint64 level, uint128 xp, uint32 wear, uint256 equippedItem)
  getCore: '0xb9181611',
};

// Per-token attribute keys = keccak256("damage") etc. Precomputed bytes32 (see getStat).
// getStat(uint256 tokenId, bytes32 key) -> uint256
const SEL_getStat = '0x44e2ef88';
const STAT_KEYS = {
  // keccak256 of the plain ascii name, as used by the writer game when calling setStat.
  damage: '0x9c5f9...PLACEHOLDER', // documented: replace with on-chain key when contract is deployed
  range: '0x...PLACEHOLDER',
  fireRate: '0x...PLACEHOLDER',
};

const pad32 = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const encUint = (n) => pad32(BigInt(n).toString(16));
const encAddr = (addr) => pad32(addr.toLowerCase().replace(/^0x/, ''));

function encodeCall(selector, ...words) {
  return selector + words.join('');
}

async function rpc(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`eth_call: ${json.error.message}`);
  return json.result; // 0x-prefixed hex
}

const hexToBigInt = (hex) => BigInt(hex && hex !== '0x' ? hex : '0x0');

// Read one tower's stats off-chain and shape it. Falls back to derived defaults when the
// open stat-store keys are unknown (placeholders above), so the game still gets a valid tower.
async function loadOneTower(rpcUrl, nftAddress, tokenId) {
  const genomeHex = await rpc(rpcUrl, nftAddress, encodeCall(SELECTORS.genomeOf, encUint(tokenId)));
  const genome = hexToBigInt(genomeHex);

  // Core: level (first 64 bits word), xp (second word). Decoded positionally.
  const coreHex = await rpc(rpcUrl, nftAddress, encodeCall(SELECTORS.getCore, encUint(tokenId)));
  const body = coreHex.replace(/^0x/, '');
  const level = Number(hexToBigInt('0x' + body.slice(0, 64)));
  const xp = Number(hexToBigInt('0x' + body.slice(64, 128)));

  // Combat stats are deterministically derived from the genome so the demo works even
  // before the open stat-store keys are finalized on-chain. Once STAT_KEYS are real, swap
  // these for getStat() reads (left as documented placeholders above).
  const seed = Number(genome % 1000n);
  return normalizeTower({
    tokenId,
    name: `Tower #${tokenId}`,
    rarity: rarityFromGenome(genome),
    stats: {
      damage: 8 + (seed % 48),
      range: 110 + (seed % 110),
      fireRate: 1.2 + ((seed % 15) / 10),
      level: level || 1,
      xp: xp || 0,
    },
  });
}

// EE3 entry point. Returns canonical towers; NEVER throws — falls back to the fixture.
export async function loadOwnedTowers() {
  // Clean build: the whole crypto path is compiled out. Dead-code-eliminated by Vite
  // because CRYPTO_BUILD is a build-time literal.
  if (!CRYPTO_BUILD) {
    return loadTowersFromFixture();
  }

  const { rpcUrl, nftAddress, ownerAddress } = CHAIN;
  if (!rpcUrl || !nftAddress || !ownerAddress) {
    return loadTowersFromFixture();
  }

  try {
    const balHex = await rpc(rpcUrl, nftAddress, encodeCall(SELECTORS.balanceOf, encAddr(ownerAddress)));
    const balance = Number(hexToBigInt(balHex));
    if (balance === 0) return loadTowersFromFixture();

    const towers = [];
    for (let i = 0; i < balance; i++) {
      const idHex = await rpc(
        rpcUrl,
        nftAddress,
        encodeCall(SELECTORS.tokenOfOwnerByIndex, encAddr(ownerAddress), encUint(i)),
      );
      const tokenId = Number(hexToBigInt(idHex));
      towers.push(await loadOneTower(rpcUrl, nftAddress, tokenId));
    }
    return towers.length ? towers : loadTowersFromFixture();
  } catch (err) {
    // Unreachable RPC / decode error -> graceful fixture fallback.
    console.warn('[chainLoader] falling back to fixture:', err.message);
    return loadTowersFromFixture();
  }
}
