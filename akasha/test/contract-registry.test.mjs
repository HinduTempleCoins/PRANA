import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { loadRegistry, extractAbi } from '../lib/contract-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ABIS_DIR = path.resolve(__dirname, '../../contracts/abis');
const RECORDER = path.resolve(__dirname, '../../contracts/scripts/lib/deployments.js');
const CHAIN_ID = 108369;

// Import the existing CJS recorder via createRequire (ESM-friendly bridge).
const require = createRequire(import.meta.url);
const recorder = require(RECORDER);

// A throwaway address (Anvil account #1) for the recorded deployment.
const TEST_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function tempDeploymentsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prana-reg-'));
  return path.join(dir, 'deployments.json');
}

test('extractAbi autodetects raw array and {abi:[...]} wrapper', () => {
  const frag = [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }];
  assert.deepEqual(extractAbi(frag), frag);
  assert.deepEqual(extractAbi({ abi: frag }), frag);
  assert.throws(() => extractAbi({ nope: 1 }), /unrecognized ABI shape/);
});

test('loads all real ABIs from contracts/abis (read-only)', () => {
  const reg = loadRegistry({ abisDir: ABIS_DIR, chainId: CHAIN_ID });
  const names = reg.list();
  assert.ok(names.length >= 60, `expected many ABIs, got ${names.length}`);
  assert.ok(reg.has('ERC20Base'));
  // Every entry parses into an ethers Interface and has a usable abi array.
  const e = reg.get('ERC20Base');
  assert.ok(Array.isArray(e.abi));
  assert.ok(e.iface.getFunction('transfer'), 'iface should expose transfer');
});

test('contract with ABI but no deployment -> address null, connect throws clearly', () => {
  const reg = loadRegistry({ abisDir: ABIS_DIR, chainId: CHAIN_ID }); // no deploymentsFile
  const e = reg.get('ERC20Base');
  assert.equal(e.address, null);
  assert.equal(e.deployment, null);
  assert.throws(() => e.connect({}), /no deployment on chainId/);
});

test('resolves deployed address from a temp deployments.json written by the real recorder', () => {
  const file = tempDeploymentsFile();
  // Record a deployment using the existing CJS recorder API (no hand-editing).
  recorder.record(
    {
      chainId: CHAIN_ID,
      chainName: 'PRANA local',
      rpc: 'http://127.0.0.1:8545',
      name: 'ERC20Base',
      address: TEST_ADDR,
      block: 7,
      txHash: '0xabc',
      constructorArgs: ['Akasha', 'AKA'],
    },
    file,
  );

  const reg = loadRegistry({ abisDir: ABIS_DIR, deploymentsFile: file, chainId: CHAIN_ID });
  const e = reg.get('ERC20Base');
  assert.equal(e.address, TEST_ADDR); // checksummed form matches
  assert.equal(e.deployment.block, 7);
  assert.deepEqual(e.deployment.constructorArgs, ['Akasha', 'AKA']);

  // connect() now returns an ethers Contract bound to the address.
  const fakeProvider = {};
  const c = e.connect(fakeProvider);
  assert.equal(c.target, TEST_ADDR);

  // A contract not in this chain's deployments still has null address.
  const other = reg.has('GovernorDAO') ? reg.get('GovernorDAO') : null;
  if (other) assert.equal(other.address, null);

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('get() on unknown name throws; missing deploymentsFile tolerated', () => {
  const reg = loadRegistry({ abisDir: ABIS_DIR, deploymentsFile: '/no/such/file.json', chainId: CHAIN_ID });
  assert.throws(() => reg.get('NotAContract'), /no contract named/);
});
