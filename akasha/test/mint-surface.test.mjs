// Tests for lib/mint-surface.mjs — mock provider + signer, no live node.
//
// Mirrors the send-flow test style: a FakeProvider answers eth_* from a table
// (function entries are called). Timers are unref'd via confirmations:0 / no
// polling so node:test exits cleanly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, getAddress, parseEther } from 'ethers';
import {
  prepareMint,
  executeMint,
  resolvePayment,
  resolveMintFunction,
  decodeMintedTokenId,
} from '../lib/mint-surface.mjs';

// anvil key #0
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FROM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const COLLECTION = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const PAYTOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// The real PRANA NFT contract ABIs we bind.
const ROYALTY_NFT_ABI = [
  'function mint(address to, string uri) returns (uint256 tokenId)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const MUTABLE_STAT_ABI = [
  'function mint(address to, uint256 genome, string uri) returns (uint256 tokenId)',
  'event Minted(uint256 indexed tokenId, address indexed to, uint256 genome)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const ENTRAIN_ABI = [
  'function mintEdition(uint256 programId, address to) payable returns (uint256 tokenId)',
  'event EditionMinted(uint256 indexed tokenId, uint256 indexed programId, address indexed buyer, uint256 pricePaid, uint256 protocolCut)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

const ERC20_IFACE = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const errIface = new Interface(['function Error(string)']);
const REVERT_NOT_MINTER = errIface.encodeFunctionData('Error', [
  'AccessControl: account is missing role',
]);

class FakeProvider {
  constructor(table) {
    this.table = table;
    this.calls = [];
  }
  async send(method, params) {
    this.calls.push({ method, params });
    const entry = this.table[method];
    if (entry === undefined) return null;
    return typeof entry === 'function' ? entry(params) : entry;
  }
}

// A healthy 1559 chain. eth_call returns '0x' (success) by default.
function baseTable(overrides = {}) {
  return {
    eth_getTransactionCount: () => '0x0',
    eth_estimateGas: '0x186a0', // 100000
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' }, // 1 gwei
    eth_maxPriorityFeePerGas: '0x3b9aca00',
    eth_call: '0x',
    eth_getBalance: '0xde0b6b3a7640000',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test('resolveMintFunction auto-picks mint / mintEdition by name', () => {
  const r1 = resolveMintFunction(ROYALTY_NFT_ABI);
  assert.equal(r1.model.name, 'mint');
  const r2 = resolveMintFunction(ENTRAIN_ABI);
  assert.equal(r2.model.name, 'mintEdition');
  assert.equal(r2.model.payable, true);
});

test('prepareMint builds a RoyaltyNFT mint tx and dry-runs OK', async () => {
  const provider = new FakeProvider(baseTable());
  const plan = await prepareMint({
    provider,
    contract: COLLECTION,
    abi: ROYALTY_NFT_ABI,
    from: FROM,
    values: { to: TO, uri: 'ipfs://meta/1' },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.fn, 'mint');
  assert.equal(plan.contract, getAddress(COLLECTION));
  assert.equal(plan.gasEstimate, 100000n);
  assert.equal(plan.value, 0n);
  // calldata encodes the right selector
  assert.match(plan.data, /^0x[0-9a-f]+$/);
  // an eth_call (dry-run) was actually issued
  assert.ok(provider.calls.some((c) => c.method === 'eth_call'));
});

test('prepareMint catches a revert via dry-run (decoded reason)', async () => {
  const provider = new FakeProvider(
    baseTable({
      eth_call: () => {
        const e = new Error('execution reverted');
        e.data = REVERT_NOT_MINTER;
        throw e;
      },
    }),
  );
  const plan = await prepareMint({
    provider,
    contract: COLLECTION,
    abi: ROYALTY_NFT_ABI,
    from: FROM,
    values: { to: TO, uri: 'ipfs://x' },
  });
  assert.equal(plan.ok, false);
  assert.match(plan.revertReason, /missing role/);
});

test('native-priced mintEdition attaches value', async () => {
  const provider = new FakeProvider(baseTable());
  const price = parseEther('0.25');
  const plan = await prepareMint({
    provider,
    contract: COLLECTION,
    abi: ENTRAIN_ABI,
    from: FROM,
    values: { programId: 3, to: TO },
    opts: { price }, // native (no payToken)
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.value, price);
  assert.equal(plan.payment.native, true);
  assert.equal(plan.payment.needsApproval, false);
});

test('ERC-20 price path requires approval when allowance < price', async () => {
  // allowance() returns 0, balanceOf() returns plenty.
  const table = baseTable({
    eth_call: (params) => {
      const data = params[0].data;
      // route by the contract being called
      if (getAddress(params[0].to) === getAddress(PAYTOKEN)) {
        const sel = data.slice(0, 10);
        if (sel === ERC20_IFACE.getFunction('allowance').selector) {
          return ERC20_IFACE.encodeFunctionResult('allowance', [0n]);
        }
        if (sel === ERC20_IFACE.getFunction('balanceOf').selector) {
          return ERC20_IFACE.encodeFunctionResult('balanceOf', [parseEther('1000')]);
        }
      }
      return '0x'; // the mint dry-run itself succeeds
    },
  });
  const provider = new FakeProvider(table);
  const price = parseEther('10');
  const plan = await prepareMint({
    provider,
    contract: COLLECTION,
    abi: ENTRAIN_ABI,
    from: FROM,
    values: { programId: 1, to: TO },
    opts: { price, payToken: PAYTOKEN },
  });
  assert.equal(plan.payment.native, false);
  assert.equal(plan.payment.needsApproval, true);
  assert.equal(plan.payment.allowance, 0n);
  assert.equal(plan.value, 0n); // ERC-20 mints carry no native value
  assert.ok(plan.payment.approveTxData.startsWith('0x'));
});

test('ERC-20 price path needs NO approval when allowance >= price', async () => {
  const price = parseEther('10');
  const table = baseTable({
    eth_call: (params) => {
      if (getAddress(params[0].to) === getAddress(PAYTOKEN)) {
        const sel = params[0].data.slice(0, 10);
        if (sel === ERC20_IFACE.getFunction('allowance').selector) {
          return ERC20_IFACE.encodeFunctionResult('allowance', [price]);
        }
        if (sel === ERC20_IFACE.getFunction('balanceOf').selector) {
          return ERC20_IFACE.encodeFunctionResult('balanceOf', [price]);
        }
      }
      return '0x';
    },
  });
  const payment = await resolvePayment(new FakeProvider(table), {
    payToken: PAYTOKEN,
    price,
    from: FROM,
    spender: COLLECTION,
  });
  assert.equal(payment.needsApproval, false);
  assert.equal(payment.allowance, price);
});

test('decodeMintedTokenId reads id from the contract Minted event', () => {
  const iface = new Interface(MUTABLE_STAT_ABI);
  const log = iface.encodeEventLog('Minted', [42n, TO, 0n]);
  const receipt = { logs: [{ address: COLLECTION, topics: log.topics, data: log.data }] };
  const id = decodeMintedTokenId(MUTABLE_STAT_ABI, receipt, { contractAddress: COLLECTION });
  assert.equal(id, 42n);
});

test('decodeMintedTokenId falls back to ERC-721 Transfer(from=0)', () => {
  const iface = new Interface(ROYALTY_NFT_ABI);
  const log = iface.encodeEventLog('Transfer', [
    '0x0000000000000000000000000000000000000000',
    TO,
    7n,
  ]);
  const receipt = { logs: [{ address: COLLECTION, topics: log.topics, data: log.data }] };
  const id = decodeMintedTokenId(ROYALTY_NFT_ABI, receipt);
  assert.equal(id, 7n);
});

test('executeMint broadcasts and decodes the minted tokenId from the receipt', async () => {
  const iface = new Interface(MUTABLE_STAT_ABI);
  const mlog = iface.encodeEventLog('Minted', [99n, TO, 0n]);
  const table = baseTable({
    eth_sendRawTransaction: '0xminthash',
    eth_getTransactionReceipt: {
      blockNumber: '0x1',
      status: '0x1',
      logs: [{ address: COLLECTION, topics: mlog.topics, data: mlog.data }],
    },
    eth_blockNumber: '0x1',
  });
  const provider = new FakeProvider(table);
  const plan = await prepareMint({
    provider,
    contract: COLLECTION,
    abi: MUTABLE_STAT_ABI,
    from: FROM,
    values: { to: TO, genome: 1234, uri: 'ipfs://g' },
  });
  assert.equal(plan.ok, true);

  const out = await executeMint({
    signer: new Wallet(PK),
    provider,
    abi: MUTABLE_STAT_ABI,
    plan,
    opts: { confirmations: 1, pollMs: 1, timeoutMs: 2000 },
  });
  assert.equal(out.hash, '0xminthash');
  assert.equal(out.tokenId, 99n);
});

test('executeMint refuses to send a reverting plan', async () => {
  const provider = new FakeProvider(
    baseTable({
      eth_call: () => {
        const e = new Error('execution reverted');
        e.data = REVERT_NOT_MINTER;
        throw e;
      },
    }),
  );
  const plan = await prepareMint({
    provider,
    contract: COLLECTION,
    abi: ROYALTY_NFT_ABI,
    from: FROM,
    values: { to: TO, uri: 'x' },
  });
  await assert.rejects(
    () =>
      executeMint({ signer: new Wallet(PK), provider, abi: ROYALTY_NFT_ABI, plan }),
    /refusing to send a reverting mint/,
  );
});

test('fixture fallback returns a deterministic plan with no network', async () => {
  const plan = await prepareMint({
    provider: null, // unused in fixture mode
    contract: COLLECTION,
    abi: ROYALTY_NFT_ABI,
    from: FROM,
    values: { to: TO, uri: 'ipfs://fx' },
    opts: { fixture: { ok: true, gasEstimate: 88000, tokenId: 5 } },
  });
  assert.equal(plan.fixture, true);
  assert.equal(plan.ok, true);
  assert.equal(plan.gasEstimate, 88000n);
  assert.equal(plan.tokenId, 5n);
  assert.equal(plan.fn, 'mint');
});
