// Tests for nft-inventory.mjs — mock provider + fixtures, no live node.
//
// The mock provider answers ethers-style `call({to,data})` by routing on the
// 4-byte selector to a per-contract handler, returning ABI-encoded results.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import {
  readInventory,
  detectStandard,
  attachUris,
  fetchMetadata,
  expandTokenUri,
  resolveUri,
  nftSurface,
} from './nft-inventory.mjs';

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const C721 = '0x1111111111111111111111111111111111111111';
const C1155 = '0x2222222222222222222222222222222222222222';

const IFACE = new Interface([
  'function supportsInterface(bytes4) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function tokenURI(uint256) view returns (string)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function uri(uint256) view returns (string)',
]);

// selector helpers
const sel = (sig) => IFACE.getFunction(sig).selector;
const SUPPORTS = sel('supportsInterface(bytes4)');
const BAL721 = sel('balanceOf(address)');
const OWNEROF = sel('ownerOf(uint256)');
const TOOBI = sel('tokenOfOwnerByIndex(address,uint256)');
const TOKENURI = sel('tokenURI(uint256)');
const NAME = sel('name()');
const SYMBOL = sel('symbol()');
const BAL1155 = sel('balanceOf(address,uint256)');
const URI = sel('uri(uint256)');

const ENC = (sig, vals) => IFACE.encodeFunctionResult(sig, vals);
const ID = { ERC721: '0x80ac58cd', ENUM: '0x780e9d63', ERC1155: '0xd9b67a26' };

/**
 * Build a mock provider from a routing table:
 *   handlers[contractLower] = (selector, decodedArgsHexData) => hexResult | throws
 */
function makeProvider(handlers) {
  return {
    async call({ to, data }) {
      const h = handlers[to.toLowerCase()];
      if (!h) throw new Error(`no handler for ${to}`);
      return h(data.slice(0, 10), data);
    },
  };
}

// An ERC-721 Enumerable collection: OWNER holds tokenIds 7 and 42.
function erc721Handler() {
  const held = ['7', '42'];
  return (selector, data) => {
    switch (selector) {
      case SUPPORTS: {
        const [id] = IFACE.decodeFunctionData('supportsInterface', data);
        const ok = id === ID.ERC721 || id === ID.ENUM;
        return ENC('supportsInterface', [ok]);
      }
      case NAME:
        return ENC('name', ['Naga Creatures']);
      case SYMBOL:
        return ENC('symbol', ['NAGA']);
      case BAL721:
        return ENC('balanceOf(address)', [BigInt(held.length)]);
      case TOOBI: {
        const [, index] = IFACE.decodeFunctionData('tokenOfOwnerByIndex', data);
        return ENC('tokenOfOwnerByIndex', [BigInt(held[Number(index)])]);
      }
      case TOKENURI: {
        const [tid] = IFACE.decodeFunctionData('tokenURI', data);
        return ENC('tokenURI', [`https://meta.test/naga/${tid}.json`]);
      }
      default:
        throw new Error('721: unexpected selector ' + selector);
    }
  };
}

// An ERC-1155 collection: OWNER holds 3 of id 100, 0 of id 200, 5 of id 300.
function erc1155Handler() {
  const balances = { 100: 3n, 200: 0n, 300: 5n };
  return (selector, data) => {
    switch (selector) {
      case SUPPORTS: {
        const [id] = IFACE.decodeFunctionData('supportsInterface', data);
        return ENC('supportsInterface', [id === ID.ERC1155]);
      }
      case BAL1155: {
        const [, tid] = IFACE.decodeFunctionData('balanceOf(address,uint256)', data);
        return ENC('balanceOf(address,uint256)', [balances[Number(tid)] ?? 0n]);
      }
      case URI:
        return ENC('uri', ['ipfs://QmDeck/{id}.json']);
      default:
        throw new Error('1155: unexpected selector ' + selector);
    }
  };
}

test('detectStandard: distinguishes 721 (enumerable) and 1155', async () => {
  const provider = makeProvider({
    [C721.toLowerCase()]: erc721Handler(),
    [C1155.toLowerCase()]: erc1155Handler(),
  });
  const a = await detectStandard(provider, C721);
  assert.equal(a.standard, 'erc721');
  assert.equal(a.enumerable, true);
  const b = await detectStandard(provider, C1155);
  assert.equal(b.standard, 'erc1155');
  assert.equal(b.enumerable, false);
});

test('readInventory: enumerates owned ERC-721 with name/symbol + tokenURI', async () => {
  const provider = makeProvider({ [C721.toLowerCase()]: erc721Handler() });
  const rows = await readInventory({
    provider,
    owner: OWNER,
    collections: [{ address: C721 }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].standard, 'erc721');
  assert.equal(rows[0].name, 'Naga Creatures');
  assert.equal(rows[0].symbol, 'NAGA');
  assert.equal(rows[0].balance, 1n);
  assert.deepEqual(rows.map((r) => r.tokenId), ['7', '42']);
  assert.equal(rows[0].tokenURI, 'https://meta.test/naga/7.json');
});

test('readInventory: ERC-1155 balances — drops zero, keeps held with amount', async () => {
  const provider = makeProvider({ [C1155.toLowerCase()]: erc1155Handler() });
  const rows = await readInventory({
    provider,
    owner: OWNER,
    collections: [{ address: C1155, standard: 'erc1155', tokenIds: [100, 200, 300] }],
  });
  assert.equal(rows.length, 2); // id 200 (balance 0) dropped
  assert.equal(rows[0].tokenId, '100');
  assert.equal(rows[0].balance, 3n);
  assert.equal(rows[1].tokenId, '300');
  assert.equal(rows[1].balance, 5n);
  assert.equal(rows[0].standard, 'erc1155');
  // {id} expanded to lowercase, zero-padded 64-hex of the id (100 → 0x…64).
  const hex100 = (100).toString(16).padStart(64, '0');
  assert.equal(rows[0].tokenURI, `ipfs://QmDeck/${hex100}.json`);
});

test('readInventory: non-enumerable 721 probed via ownerOf candidate ids', async () => {
  // Handler: 721 but NOT enumerable; ownerOf(5)=OWNER, ownerOf(6)=OTHER.
  const handler = (selector, data) => {
    if (selector === SUPPORTS) {
      const [id] = IFACE.decodeFunctionData('supportsInterface', data);
      return ENC('supportsInterface', [id === ID.ERC721]); // ENUM → false
    }
    if (selector === NAME) return ENC('name', ['Manual']);
    if (selector === SYMBOL) throw new Error('no symbol');
    if (selector === OWNEROF) {
      const [tid] = IFACE.decodeFunctionData('ownerOf', data);
      if (tid === 5n) return ENC('ownerOf', [OWNER]);
      if (tid === 6n) return ENC('ownerOf', [OTHER]);
      throw new Error('nonexistent token');
    }
    if (selector === TOKENURI) return ENC('tokenURI', ['']); // no metadata ext
    throw new Error('unexpected ' + selector);
  };
  const provider = makeProvider({ [C721.toLowerCase()]: handler });
  const rows = await readInventory({
    provider,
    owner: OWNER,
    collections: [{ address: C721, tokenIds: [5, 6, 7] }], // 7 reverts → skipped
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenId, '5');
  assert.equal(rows[0].name, 'Manual');
  assert.equal(rows[0].symbol, undefined);
  assert.equal(rows[0].tokenURI, undefined); // empty uri not attached
});

test('readInventory: empty inventory returns []', async () => {
  const handler = (selector) => {
    if (selector === SUPPORTS) return ENC('supportsInterface', [false]);
    throw new Error('unexpected');
  };
  const provider = makeProvider({ [C721.toLowerCase()]: handler });
  const rows = await readInventory({
    provider,
    owner: OWNER,
    collections: [{ address: C721 }],
  });
  assert.deepEqual(rows, []);
});

test('readInventory: FIXTURE mode (array) works with no provider', async () => {
  const rows = await readInventory({
    owner: OWNER,
    fixtures: [
      { contract: C721, standard: 'erc721', tokenId: 7, name: 'Naga', tokenURI: 'x' },
      { contract: C1155, standard: 'erc1155', tokenId: '300', balance: 5 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tokenId, '7');
  assert.equal(rows[0].balance, 1n); // defaulted
  assert.equal(rows[1].balance, 5n);
  assert.equal(rows[1].standard, 'erc1155');
});

test('readInventory: FIXTURE mode (owner map) selects by owner', async () => {
  const rows = await readInventory({
    owner: OWNER,
    fixtures: {
      [OWNER.toLowerCase()]: [{ contract: C721, standard: 'erc721', tokenId: 1 }],
      [OTHER.toLowerCase()]: [{ contract: C721, standard: 'erc721', tokenId: 2 }],
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenId, '1');
});

test('attachUris: fetches + parses metadata when enabled (injected fetch)', async () => {
  const holdings = [
    { contract: C721, standard: 'erc721', tokenId: '7', balance: 1n },
  ];
  const provider = makeProvider({ [C721.toLowerCase()]: erc721Handler() });
  let fetched = null;
  const mockFetch = async (url) => {
    fetched = url;
    return { ok: true, async json() { return { name: 'Naga #7', image: 'ipfs://img' }; } };
  };
  await attachUris(provider, holdings, { fetchMetadata: true, fetch: mockFetch });
  assert.equal(holdings[0].tokenURI, 'https://meta.test/naga/7.json');
  assert.equal(fetched, 'https://meta.test/naga/7.json');
  assert.equal(holdings[0].metadata.name, 'Naga #7');
});

test('fetchMetadata: parses data: base64 JSON URIs without network', async () => {
  const json = JSON.stringify({ name: 'Inline', value: 1 });
  const uri = 'data:application/json;base64,' + Buffer.from(json).toString('base64');
  const meta = await fetchMetadata(uri);
  assert.equal(meta.name, 'Inline');
  assert.equal(meta.value, 1);
});

test('fetchMetadata: network failure is guarded → undefined', async () => {
  const meta = await fetchMetadata('https://nope.test/x.json', {
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(meta, undefined);
});

test('expandTokenUri + resolveUri helpers', () => {
  assert.equal(
    expandTokenUri('ipfs://Q/{id}.json', '255'),
    'ipfs://Q/' + 'ff'.padStart(64, '0') + '.json',
  );
  assert.equal(expandTokenUri('https://x/7', '7'), 'https://x/7'); // no {id} → unchanged
  assert.equal(resolveUri('ipfs://QmHash/1.json'), 'https://ipfs.io/ipfs/QmHash/1.json');
  assert.equal(resolveUri('https://x/1.json'), 'https://x/1.json');
});

test('nftSurface: classifies abis', () => {
  assert.equal(
    nftSurface([
      { type: 'function', name: 'ownerOf', inputs: [{}] },
      { type: 'function', name: 'tokenURI', inputs: [{}] },
    ]),
    'erc721',
  );
  assert.equal(
    nftSurface([
      { type: 'function', name: 'uri', inputs: [{}] },
      { type: 'function', name: 'balanceOf', inputs: [{}, {}] },
    ]),
    'erc1155',
  );
  assert.equal(nftSurface([{ type: 'function', name: 'transfer', inputs: [] }]), null);
});

test('readInventory: invalid owner throws; missing provider+fixtures throws', async () => {
  await assert.rejects(() => readInventory({ owner: 'nope' }), /invalid owner/);
  await assert.rejects(
    () => readInventory({ owner: OWNER, collections: [] }),
    /provider with a call\(\) method is required/,
  );
});
