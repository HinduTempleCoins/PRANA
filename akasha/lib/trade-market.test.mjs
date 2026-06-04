// Tests for trade-market.mjs — mock marketplace, no live node. (AK13)
//
// We build a tiny mock provider that answers eth_call by decoding the calldata
// selector and returning ABI-encoded results (or a revert payload). This lets us
// assert the EXACT calldata the driver builds against the real RoyaltyMarketplace
// signatures, the approve-vs-native buy path, the seller-only cancel revert, and
// fixture parsing — all with `node --test`, no chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, getAddress } from 'ethers';
import {
  createTradeMarket,
  normalizeListing,
  decodeMarketRevert,
  marketplaceIface,
} from './trade-market.mjs';

const abi = AbiCoder.defaultAbiCoder();
const erc20 = new Interface([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const erc721 = new Interface([
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function approve(address,uint256)',
]);

const MARKET = '0x00000000000000000000000000000000000000AB';
const NFT = '0x1111111111111111111111111111111111111111';
const PAYTOKEN = '0x2222222222222222222222222222222222222222';
const SELLER = '0x3333333333333333333333333333333333333333';
const BUYER = '0x4444444444444444444444444444444444444444';

// selector helpers
const sel = (data) => data.slice(0, 10);
const SEL = {
  listings: marketplaceIface.getFunction('listings').selector,
  nextListingId: marketplaceIface.getFunction('nextListingId').selector,
  allowance: erc20.getFunction('allowance').selector,
  isApprovedForAll: erc721.getFunction('isApprovedForAll').selector,
  getApproved: erc721.getFunction('getApproved').selector,
};

const REVERT = '__REVERT__';

/**
 * Mock provider. `state` controls eth_call answers:
 *   listings: { [id]: {seller,nft,tokenId,payToken,price,active} | REVERT-string }
 *   nextListingId: bigint
 *   allowance: bigint
 *   nftApprovedForAll: bool ; nftGetApproved: address
 *   callRevert: per-`to` revert payload for action dry-runs (e.g. buy/cancel)
 */
function makeProvider(state) {
  const sent = [];
  return {
    sent,
    async send(method, params) {
      if (method === 'eth_sendRawTransaction') {
        sent.push(params[0]);
        return '0xhash';
      }
      if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
      const [callObj] = params;
      const to = getAddress(callObj.to);
      const data = callObj.data;
      const s = sel(data);

      // Marketplace reads
      if (to === getAddress(MARKET)) {
        if (s === SEL.nextListingId) {
          return abi.encode(['uint256'], [state.nextListingId ?? 0n]);
        }
        if (s === SEL.listings) {
          const [idBn] = marketplaceIface.decodeFunctionData('listings', data);
          const l = state.listings?.[idBn.toString()];
          if (l === REVERT) throw revertErr('inactive');
          if (!l) {
            return abi.encode(
              ['address', 'address', 'uint256', 'address', 'uint256', 'bool'],
              ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000', 0n, false],
            );
          }
          return abi.encode(
            ['address', 'address', 'uint256', 'address', 'uint256', 'bool'],
            [l.seller, l.nft, l.tokenId, l.payToken, l.price, l.active],
          );
        }
        // An action dry-run (buy/cancel) routed to the marketplace as eth_call.
        if (state.actionRevert) throw revertErr(state.actionRevert);
        return '0x';
      }

      // ERC-20 reads
      if (to === getAddress(PAYTOKEN) && s === SEL.allowance) {
        return abi.encode(['uint256'], [state.allowance ?? 0n]);
      }
      // ERC-721 reads
      if (to === getAddress(NFT)) {
        if (s === SEL.isApprovedForAll) {
          return abi.encode(['bool'], [state.nftApprovedForAll ?? false]);
        }
        if (s === SEL.getApproved) {
          return abi.encode(['address'], [state.nftGetApproved ?? '0x0000000000000000000000000000000000000000']);
        }
      }
      return '0x';
    },
  };
}

// Build a geth-style revert error carrying the Error(string) payload in err.data.
function revertErr(reason) {
  const iface = new Interface(['function Error(string)']);
  const data = iface.encodeFunctionData('Error', [reason]);
  const e = new Error('execution reverted');
  e.data = data;
  return e;
}

// ---------------------------------------------------------------------------

test('list: builds list() calldata + prepends NFT approval when not approved', async () => {
  const provider = makeProvider({ nftApprovedForAll: false, nftGetApproved: '0x0000000000000000000000000000000000000000' });
  const m = createTradeMarket({ provider, marketplace: MARKET });

  const { action, approval } = await m.list({
    from: SELLER,
    nft: NFT,
    tokenId: 7,
    payToken: PAYTOKEN,
    price: 1000n,
  });

  // The action is a list() call to the marketplace with the exact args.
  assert.equal(action.kind, 'list');
  assert.equal(getAddress(action.to), getAddress(MARKET));
  const decoded = marketplaceIface.decodeFunctionData('list', action.data);
  assert.equal(getAddress(decoded[0]), getAddress(NFT));
  assert.equal(decoded[1], 7n);
  assert.equal(getAddress(decoded[2]), getAddress(PAYTOKEN));
  assert.equal(decoded[3], 1000n);
  assert.equal(action.value, 0n);

  // Approval required (per-token approve of the marketplace).
  assert.ok(approval, 'expected an NFT approval tx');
  assert.equal(approval.kind, 'approve-erc721');
  assert.equal(getAddress(approval.to), getAddress(NFT));
});

test('list: no approval tx when seller already setApprovalForAll', async () => {
  const provider = makeProvider({ nftApprovedForAll: true });
  const m = createTradeMarket({ provider, marketplace: MARKET });
  const { approval } = await m.list({ from: SELLER, nft: NFT, tokenId: 1, payToken: PAYTOKEN, price: 5n });
  assert.equal(approval, null);
});

test('list: rejects zero price (mirrors contract require price>0)', async () => {
  const provider = makeProvider({});
  const m = createTradeMarket({ provider, marketplace: MARKET });
  await assert.rejects(
    () => m.list({ from: SELLER, nft: NFT, tokenId: 1, payToken: PAYTOKEN, price: 0 }),
    /price must be > 0/,
  );
});

test('buy with ERC-20 requires approval when allowance < price', async () => {
  const provider = makeProvider({
    listings: { 0: { seller: SELLER, nft: NFT, tokenId: 1n, payToken: PAYTOKEN, price: 1000n, active: true } },
    allowance: 0n, // below price → approval needed
  });
  const m = createTradeMarket({ provider, marketplace: MARKET });

  const { action, approval, listing } = await m.buy(0, { from: BUYER });

  // buy() is a marketplace call carrying NO native value (ERC-20 settlement).
  assert.equal(action.kind, 'buy');
  assert.equal(action.value, 0n);
  const decoded = marketplaceIface.decodeFunctionData('buy', action.data);
  assert.equal(decoded[0], 0n);

  // Approval is an ERC-20 approve(spender=market, amount=price) on the payToken.
  assert.ok(approval, 'expected an ERC-20 approval tx');
  assert.equal(approval.kind, 'approve-erc20');
  assert.equal(getAddress(approval.to), getAddress(PAYTOKEN));
  const ap = erc20.decodeFunctionData('approve', approval.data);
  assert.equal(getAddress(ap[0]), getAddress(MARKET));
  assert.equal(ap[1], listing.price); // exactly the price
});

test('buy: no approval tx when allowance already covers price', async () => {
  const provider = makeProvider({
    listings: { 0: { seller: SELLER, nft: NFT, tokenId: 1n, payToken: PAYTOKEN, price: 1000n, active: true } },
    allowance: 5000n, // already enough
  });
  const m = createTradeMarket({ provider, marketplace: MARKET });
  const { approval, sim } = await m.buy(0, { from: BUYER });
  assert.equal(approval, null);
  // With allowance present, we dry-run the buy (marketplace returns 0x → ok).
  assert.equal(sim.ok, true);
});

test('buy: rejects an inactive/missing listing', async () => {
  const provider = makeProvider({ listings: {}, allowance: 0n });
  const m = createTradeMarket({ provider, marketplace: MARKET });
  await assert.rejects(() => m.buy(99, { from: BUYER }), /not active/);
});

test('cancel by non-seller: dry-run surfaces the decoded "not seller" revert', async () => {
  const provider = makeProvider({ actionRevert: 'not seller' });
  const m = createTradeMarket({ provider, marketplace: MARKET });

  const { action, sim } = await m.cancel(0, { from: BUYER });
  assert.equal(action.kind, 'cancel');
  const decoded = marketplaceIface.decodeFunctionData('cancel', action.data);
  assert.equal(decoded[0], 0n);

  assert.equal(sim.ok, false);
  assert.equal(sim.revertReason, 'not seller');
});

test('cancel by seller: dry-run succeeds', async () => {
  const provider = makeProvider({}); // no actionRevert → marketplace returns 0x
  const m = createTradeMarket({ provider, marketplace: MARKET });
  const { sim } = await m.cancel(0, { from: SELLER });
  assert.equal(sim.ok, true);
});

test('decodeMarketRevert decodes Error(string) and ignores non-payloads', () => {
  const iface = new Interface(['function Error(string)']);
  const payload = iface.encodeFunctionData('Error', ['inactive']);
  assert.equal(decodeMarketRevert(payload), 'inactive');
  assert.equal(decodeMarketRevert('0x'), null);
  assert.equal(decodeMarketRevert(null), null);
  assert.equal(decodeMarketRevert('0xdeadbeef'), null);
});

test('listings parsed from fixtures (offline) — active filter applied', async () => {
  const fixtures = [
    { listingId: 0, seller: SELLER, nft: NFT, tokenId: 1n, payToken: PAYTOKEN, price: 1000n, active: true },
    { listingId: 1, seller: SELLER, nft: NFT, tokenId: 2n, payToken: PAYTOKEN, price: 2000n, active: false },
  ];
  // No provider RPC should be needed for fixture loads; pass a provider that
  // throws on any call to prove the fixture path is offline.
  const provider = { send() { throw new Error('should not hit RPC in fixture mode'); } };
  const m = createTradeMarket({ provider, marketplace: MARKET, opts: { fixtures } });

  const active = await m.loadListings();
  assert.equal(active.length, 1);
  assert.equal(active[0].listingId, '0');
  assert.equal(active[0].price, 1000n);
  assert.equal(getAddress(active[0].seller), getAddress(SELLER));

  const all = await m.loadListings({ activeOnly: false });
  assert.equal(all.length, 2);
});

test('fixture buy: no RPC, no approval, returns the fixture listing', async () => {
  const fixtures = [{ listingId: 0, seller: SELLER, nft: NFT, tokenId: 1n, payToken: PAYTOKEN, price: 1000n, active: true }];
  const provider = { send() { throw new Error('no RPC in fixture mode'); } };
  const m = createTradeMarket({ provider, marketplace: MARKET, opts: { fixtures } });
  const { action, approval, listing, sim } = await m.buy(0, { from: BUYER });
  assert.equal(approval, null);
  assert.equal(action.value, 0n);
  assert.equal(listing.price, 1000n);
  assert.equal(sim.ok, true);
});

test('getListing reads + normalizes the public listings() getter', async () => {
  const provider = makeProvider({
    listings: { 3: { seller: SELLER, nft: NFT, tokenId: 42n, payToken: PAYTOKEN, price: 777n, active: true } },
  });
  const m = createTradeMarket({ provider, marketplace: MARKET });
  const l = await m.getListing(3);
  assert.equal(l.listingId, '3');
  assert.equal(l.tokenId, '42');
  assert.equal(l.price, 777n);
  assert.equal(l.active, true);
  assert.equal(getAddress(l.payToken), getAddress(PAYTOKEN));
});

test('loadListings (live): walks nextListingId then listings(i), active-only', async () => {
  const provider = makeProvider({
    nextListingId: 3n,
    listings: {
      0: { seller: SELLER, nft: NFT, tokenId: 1n, payToken: PAYTOKEN, price: 10n, active: true },
      1: { seller: SELLER, nft: NFT, tokenId: 2n, payToken: PAYTOKEN, price: 20n, active: false },
      2: { seller: BUYER, nft: NFT, tokenId: 3n, payToken: PAYTOKEN, price: 30n, active: true },
    },
  });
  const m = createTradeMarket({ provider, marketplace: MARKET });
  const rows = await m.loadListings();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.listingId), ['0', '2']);
});

test('normalizeListing accepts both tuple-array and plain-object shapes', () => {
  const tuple = [SELLER, NFT, 9n, PAYTOKEN, 500n, true];
  const a = normalizeListing(5, tuple);
  assert.equal(a.tokenId, '9');
  assert.equal(a.price, 500n);
  assert.equal(a.active, true);

  const obj = { seller: SELLER, nft: NFT, tokenId: 9n, payToken: PAYTOKEN, price: 500n, active: true };
  const b = normalizeListing(5, obj);
  assert.deepEqual(a, b);
});
