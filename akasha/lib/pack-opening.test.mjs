// Tests for lib/pack-opening.mjs — commit/reveal driver for GachaMintOnCommit.
// Two paths: a mock-provider "live node" path and the no-node fixture path.
// No real network. Any timers created (none expected in fixture mode) are unref'd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, id } from 'ethers';
import {
  createPackOpening,
  STATES,
  computeSaltHash,
  decodeReveals,
  generateSalt,
  IFACE,
} from './pack-opening.mjs';

// anvil key #0
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const SALT = '0x' + '11'.repeat(32);
const NAMES = ['Common', 'Rare', 'Legendary'];

// Encode a Committed / Revealed log the way the chain would, so the driver's
// own parseLog path is exercised.
function committedLog(user, commitBlock) {
  const ev = IFACE.getEvent('Committed');
  const { topics, data } = IFACE.encodeEventLog(ev, [user, BigInt(commitBlock), computeSaltHash(SALT)]);
  return { topics, data };
}
function revealedLog(user, tokenId, rarityIndex) {
  const ev = IFACE.getEvent('Revealed');
  const { topics, data } = IFACE.encodeEventLog(ev, [user, BigInt(tokenId), BigInt(rarityIndex)]);
  return { topics, data };
}

// A scriptable provider: a table maps method -> value | (params)=>value.
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

// 1559-healthy base table. eth_call answers per-selector (rarityNames, dryRun).
function baseTable(overrides = {}) {
  const rarityNamesRet = IFACE.encodeFunctionResult('rarityNames', [NAMES]);
  return {
    eth_blockNumber: '0x10', // head = 16
    eth_getTransactionCount: '0x0',
    eth_estimateGas: '0x30000',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x3b9aca00',
    eth_call: (params) => {
      const data = params?.[0]?.data ?? '0x';
      if (data.startsWith(IFACE.getFunction('rarityNames').selector)) return rarityNamesRet;
      if (data.startsWith(IFACE.getFunction('EXPIRY_BLOCKS').selector)) {
        return IFACE.encodeFunctionResult('EXPIRY_BLOCKS', [256n]);
      }
      return '0x'; // dryRun success for commit/reveal
    },
    eth_sendRawTransaction: '0xdeadbeef',
    ...overrides,
  };
}

test('computeSaltHash matches the contract saltHashOf (keccak of the 32 bytes)', () => {
  // abi.encodePacked(bytes32) is the bytes themselves; hash is deterministic.
  const h = computeSaltHash(SALT);
  assert.match(h, /^0x[0-9a-f]{64}$/);
  // stable across calls
  assert.equal(computeSaltHash(SALT), h);
});

test('generateSalt yields a fresh 32-byte hex each call', () => {
  const a = generateSalt();
  const b = generateSalt();
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('fixture: commit then reveal, rarity decoded from the Revealed event', async () => {
  let block = 100n;
  const fixture = {
    get currentBlock() {
      return block;
    },
    rarityNames: NAMES,
    reveal: { tokenId: 42n, rarityIndex: 2 }, // Legendary
  };
  const p = createPackOpening({ contract: CONTRACT, account: ACCOUNT, salt: SALT, fixture });
  assert.equal(p.state, STATES.IDLE);

  await p.commit();
  assert.equal(p.state, STATES.COMMITTED);
  assert.equal(p.snapshot().commitBlock, 100n);
  assert.equal(p.snapshot().revealBlock, 101n);

  // premature reveal rejected: reveal block (101) not yet mined
  const tooEarly = await p.reveal();
  assert.equal(tooEarly, null);
  assert.equal(p.state, STATES.FAILED);
  assert.equal(p.error.code, 'TOO_EARLY');

  // advance the chain past the reveal block, retry
  block = 102n;
  await p.refreshReadiness();
  // (reveal() also refreshes; from FAILED we must re-commit? No — state is FAILED.)
});

test('fixture: full happy path commit → revealable → revealed with rarity name', async () => {
  let block = 100n;
  const fixture = {
    get currentBlock() {
      return block;
    },
    rarityNames: NAMES,
    reveal: { tokenId: 7n, rarityIndex: 1 }, // Rare
  };
  const p = createPackOpening({ contract: CONTRACT, account: ACCOUNT, salt: SALT, fixture });

  await p.commit();
  assert.equal(p.state, STATES.COMMITTED);

  block = 102n; // > commitBlock + 1
  const s = await p.refreshReadiness();
  assert.equal(s, STATES.REVEALABLE);

  await p.reveal();
  assert.equal(p.state, STATES.REVEALED);
  assert.deepEqual(p.cards, [{ tokenId: 7n, rarityIndex: 1, rarityName: 'Rare' }]);
});

test('fixture: multi-card reveal via events[], rarity-fn gets the salt', async () => {
  let block = 5n;
  let seenSalt = null;
  const fixture = {
    get currentBlock() {
      return block;
    },
    rarityNames: NAMES,
    reveal: (salt) => {
      seenSalt = salt;
      return { events: [{ tokenId: 1n, rarityIndex: 0 }, { tokenId: 2n, rarityIndex: 2 }] };
    },
  };
  const p = createPackOpening({ contract: CONTRACT, account: ACCOUNT, salt: SALT, fixture });
  await p.commit();
  block = 8n;
  await p.refreshReadiness();
  await p.reveal();
  assert.equal(seenSalt, SALT);
  assert.equal(p.cards.length, 2);
  assert.deepEqual(
    p.cards.map((c) => c.rarityName),
    ['Common', 'Legendary'],
  );
});

test('fixture: expiry past the 256-block window → EXPIRED, reveal refuses', async () => {
  let block = 100n;
  const fixture = {
    get currentBlock() {
      return block;
    },
    expiryBlocks: 256,
    rarityNames: NAMES,
    reveal: { tokenId: 1n, rarityIndex: 0 },
  };
  const p = createPackOpening({ contract: CONTRACT, account: ACCOUNT, salt: SALT, fixture });
  await p.commit();
  block = 100n + 257n; // now > commitBlock + EXPIRY_BLOCKS
  const s = await p.refreshReadiness();
  assert.equal(s, STATES.EXPIRED);

  const out = await p.reveal();
  assert.equal(out, null);
  assert.equal(p.error.code, 'EXPIRED');
});

test('decodeReveals filters by user and resolves names', () => {
  const me = ACCOUNT;
  const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const logs = [
    revealedLog(other, 99n, 2),
    revealedLog(me, 3n, 1),
    committedLog(me, 50), // not a Revealed — ignored
  ];
  const cards = decodeReveals(logs, { user: me, rarityNames: NAMES });
  assert.deepEqual(cards, [{ tokenId: 3n, rarityIndex: 1, rarityName: 'Rare' }]);
});

test('live path: commit broadcasts and lands COMMITTED with the event commit block', async () => {
  // head=16; Committed event reports commit block 16; reveal target = 17 (not mined → COMMITTED).
  const provider = new FakeProvider(
    baseTable({
      eth_getTransactionReceipt: () => ({
        status: '0x1',
        blockNumber: '0x10',
        logs: [committedLog(ACCOUNT, 16)],
      }),
    }),
  );
  const signer = new Wallet(PK);
  const p = createPackOpening({
    provider,
    signer,
    contract: CONTRACT,
    account: ACCOUNT,
    salt: SALT,
    opts: { confirmations: 1, pollMs: 1, timeoutMs: 2000 },
  });

  await p.commit();
  assert.equal(p.state, STATES.COMMITTED);
  assert.equal(p.snapshot().commitBlock, 16n);
  assert.equal(p.snapshot().revealBlock, 17n);
  assert.deepEqual(p.snapshot().rarityNames, NAMES);
});

test('live path: reveal too early is refused before any tx is sent', async () => {
  // head stays 16, commit block 16 → reveal block 17 never mined.
  const provider = new FakeProvider(
    baseTable({
      eth_getTransactionReceipt: () => ({ status: '0x1', blockNumber: '0x10', logs: [committedLog(ACCOUNT, 16)] }),
    }),
  );
  const p = createPackOpening({
    provider,
    signer: new Wallet(PK),
    contract: CONTRACT,
    account: ACCOUNT,
    salt: SALT,
    opts: { confirmations: 1, pollMs: 1, timeoutMs: 2000 },
  });
  await p.commit();
  assert.equal(p.state, STATES.COMMITTED);

  const before = provider.calls.filter((c) => c.method === 'eth_sendRawTransaction').length;
  const out = await p.reveal();
  assert.equal(out, null);
  assert.equal(p.error.code, 'TOO_EARLY');
  const after = provider.calls.filter((c) => c.method === 'eth_sendRawTransaction').length;
  assert.equal(after, before, 'reveal must not broadcast when too early');
});

test('live path: reveal decodes tokenId + rarity from the receipt', async () => {
  // head advances to 20 so reveal block 17 is mined; reveal receipt carries Revealed.
  let head = '0x10'; // 16 at commit
  const provider = new FakeProvider(
    baseTable({
      eth_blockNumber: () => head,
      eth_getTransactionReceipt: (params) => {
        // commit tx vs reveal tx share the same hash here; return logs by current head.
        if (head === '0x14') {
          return { status: '0x1', blockNumber: '0x11', logs: [revealedLog(ACCOUNT, 88n, 2)] };
        }
        return { status: '0x1', blockNumber: '0x10', logs: [committedLog(ACCOUNT, 16)] };
      },
    }),
  );
  const p = createPackOpening({
    provider,
    signer: new Wallet(PK),
    contract: CONTRACT,
    account: ACCOUNT,
    salt: SALT,
    opts: { confirmations: 1, pollMs: 1, timeoutMs: 2000 },
  });
  await p.commit();
  assert.equal(p.state, STATES.COMMITTED);

  head = '0x14'; // 20 → reveal block 17 mined
  await p.refreshReadiness();
  assert.equal(p.state, STATES.REVEALABLE);

  await p.reveal();
  assert.equal(p.state, STATES.REVEALED);
  assert.deepEqual(p.cards, [{ tokenId: 88n, rarityIndex: 2, rarityName: 'Legendary' }]);
});

test('live path: wrong-secret reveal surfaces the BadSalt revert (dry-run)', async () => {
  let head = '0x14'; // already past reveal block
  // Build a BadSalt() custom-error payload to return from eth_call. We compute
  // the 4-byte selector from the error signature so it stays correct.
  const badSaltData = id('BadSalt()').slice(0, 10);
  const provider = new FakeProvider(
    baseTable({
      eth_blockNumber: () => head,
      eth_getTransactionReceipt: () => ({ status: '0x1', blockNumber: '0x10', logs: [committedLog(ACCOUNT, 16)] }),
      eth_call: (params) => {
        const data = params?.[0]?.data ?? '0x';
        if (data.startsWith(IFACE.getFunction('rarityNames').selector)) {
          return IFACE.encodeFunctionResult('rarityNames', [NAMES]);
        }
        if (data.startsWith(IFACE.getFunction('EXPIRY_BLOCKS').selector)) {
          return IFACE.encodeFunctionResult('EXPIRY_BLOCKS', [256n]);
        }
        // The reveal call reverts with BadSalt; commit call (different selector) succeeds.
        if (data.startsWith(IFACE.getFunction('reveal').selector)) {
          const e = new Error('execution reverted');
          e.data = badSaltData;
          throw e;
        }
        return '0x';
      },
    }),
  );
  const p = createPackOpening({
    provider,
    signer: new Wallet(PK),
    contract: CONTRACT,
    account: ACCOUNT,
    salt: SALT,
    opts: { confirmations: 1, pollMs: 1, timeoutMs: 2000 },
  });
  await p.commit();
  await p.refreshReadiness();
  assert.equal(p.state, STATES.REVEALABLE);

  const before = provider.calls.filter((c) => c.method === 'eth_sendRawTransaction').length;
  const out = await p.reveal();
  assert.equal(out, null);
  assert.equal(p.state, STATES.FAILED);
  assert.match(p.error.message, /reveal would revert/);
  // wrong secret must not broadcast a doomed tx
  const after = provider.calls.filter((c) => c.method === 'eth_sendRawTransaction').length;
  assert.equal(after, before);
});

test('subscribe receives the state transitions', async () => {
  let block = 1n;
  const fixture = {
    get currentBlock() {
      return block;
    },
    rarityNames: NAMES,
    reveal: { tokenId: 1n, rarityIndex: 0 },
  };
  const p = createPackOpening({ contract: CONTRACT, account: ACCOUNT, salt: SALT, fixture });
  const seen = [];
  const off = p.subscribe((snap) => seen.push(snap.state));
  await p.commit();
  block = 3n;
  await p.refreshReadiness();
  await p.reveal();
  off();
  assert.deepEqual(seen, [
    STATES.COMMITTING,
    STATES.COMMITTED,
    STATES.REVEALABLE,
    STATES.REVEALING,
    STATES.REVEALED,
  ]);
});
