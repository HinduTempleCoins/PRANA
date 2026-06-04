// Tests for tools/deploy-wizard.mjs — pure parts only (no chain, no key).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress, AbiCoder } from 'ethers';
import {
  parseArgs,
  buildCreateTokenTx,
  tokenAddressFromReceipt,
  buildWizardVerification,
  tokenContractFor,
} from '../tools/deploy-wizard.mjs';
import { loadBuildInfo } from '../lib/verification-helper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTORY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const MINT_TO = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ERC20BASE_BUILDINFO = path.resolve(
  __dirname,
  '..',
  '..',
  'contracts',
  'artifacts',
  'build-info',
  '88f2a5378feea038dd0b3e60fe1c2afa.json',
);

// --- parseArgs --------------------------------------------------------------

test('parseArgs: flags, =form, aliases, and booleans', () => {
  const o = parseArgs([
    '--name', 'Prana Gold',
    '--symbol=PGLD',
    '--cap', '1000000000000000000000',
    '--initial-mint', '500000000000000000000',
    '--mint-to', MINT_TO,
    '--clones',
    '--dry-run',
    '--rpc', 'http://localhost:9999',
    '--chain-id', '108369',
  ]);
  assert.equal(o.name, 'Prana Gold');
  assert.equal(o.symbol, 'PGLD');
  assert.equal(o.cap, '1000000000000000000000');
  assert.equal(o.initialMint, '500000000000000000000');
  assert.equal(o.mintTo, MINT_TO);
  assert.equal(o.clones, true);
  assert.equal(o.dryRun, true);
  assert.equal(o.rpc, 'http://localhost:9999');
  assert.equal(o.chainId, 108369);
});

test('parseArgs: defaults + error cases', () => {
  const o = parseArgs(['--name', 'X', '--symbol', 'X']);
  assert.equal(o.clones, false);
  assert.equal(o.dryRun, false);
  assert.equal(o.chainId, 108369);
  assert.equal(o.rpc, 'http://127.0.0.1:8545');

  assert.throws(() => parseArgs(['--name']), /expects a value/);
  assert.throws(() => parseArgs(['bogus']), /unexpected argument/);
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown flag/);
});

// --- buildCreateTokenTx -----------------------------------------------------

test('buildCreateTokenTx: encodes createToken with coerced args', () => {
  const { to, data, args } = buildCreateTokenTx({
    factoryAddress: FACTORY,
    name: 'Prana Gold',
    symbol: 'PGLD',
    cap: '1000',
    initialMint: '250',
    mintTo: MINT_TO.toLowerCase(),
  });
  assert.equal(to, getAddress(FACTORY));
  assert.equal(args.cap, 1000n);
  assert.equal(args.initialMint, 250n);
  assert.equal(args.mintTo, MINT_TO); // checksummed

  // decode back and check the selector + args round-trip
  const iface = new Interface([
    'function createToken(string,string,uint256,uint256,address) returns (address)',
  ]);
  const decoded = iface.decodeFunctionData('createToken', data);
  assert.equal(decoded[0], 'Prana Gold');
  assert.equal(decoded[1], 'PGLD');
  assert.equal(decoded[2], 1000n);
  assert.equal(decoded[3], 250n);
  assert.equal(decoded[4], MINT_TO);
});

test('buildCreateTokenTx: zero mint allows blank mintTo (zero address)', () => {
  const { args } = buildCreateTokenTx({
    factoryAddress: FACTORY,
    name: 'NoMint',
    symbol: 'NM',
    cap: '0',
    initialMint: '0',
  });
  assert.equal(args.mintTo, '0x0000000000000000000000000000000000000000');
  assert.equal(args.cap, 0n);
});

test('buildCreateTokenTx: guards', () => {
  assert.throws(
    () => buildCreateTokenTx({ factoryAddress: '0xnope', name: 'A', symbol: 'A' }),
    /invalid factory address/,
  );
  assert.throws(
    () => buildCreateTokenTx({ factoryAddress: FACTORY, name: '', symbol: 'A' }),
    /name is required/,
  );
  // minting without a mintTo
  assert.throws(
    () => buildCreateTokenTx({ factoryAddress: FACTORY, name: 'A', symbol: 'A', initialMint: '10' }),
    /mintTo is required/,
  );
  // initialMint exceeds cap
  assert.throws(
    () =>
      buildCreateTokenTx({
        factoryAddress: FACTORY,
        name: 'A',
        symbol: 'A',
        cap: '5',
        initialMint: '10',
        mintTo: MINT_TO,
      }),
    /exceeds cap/,
  );
});

// --- tokenAddressFromReceipt ------------------------------------------------

test('tokenAddressFromReceipt: decodes TokenCreated', () => {
  const iface = new Interface([
    'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 cap)',
  ]);
  const log = iface.encodeEventLog('TokenCreated', [TOKEN, MINT_TO, 'N', 'S', 1000n]);
  const receipt = { logs: [{ topics: log.topics, data: log.data }] };
  assert.equal(tokenAddressFromReceipt(receipt), TOKEN);
});

test('tokenAddressFromReceipt: decodes CloneCreated and ignores noise', () => {
  const iface = new Interface([
    'event CloneCreated(address indexed token, address indexed creator, string name, string symbol, uint256 cap, bytes32 salt)',
  ]);
  const log = iface.encodeEventLog('CloneCreated', [TOKEN, MINT_TO, 'N', 'S', 0n, '0x' + '00'.repeat(32)]);
  const receipt = {
    logs: [
      { topics: ['0xdeadbeef'], data: '0x' }, // unrelated, must be skipped
      { topics: log.topics, data: log.data },
    ],
  };
  assert.equal(tokenAddressFromReceipt(receipt), TOKEN);
});

test('tokenAddressFromReceipt: returns null when no event present', () => {
  assert.equal(tokenAddressFromReceipt({ logs: [] }), null);
});

// --- verification payload ---------------------------------------------------

test('tokenContractFor: wizard vs clones', () => {
  const args = { name: 'N', symbol: 'S', cap: 1000n };
  const w = tokenContractFor({ clones: false, args, creator: MINT_TO });
  assert.equal(w.contractName, 'ERC20Base');
  assert.deepEqual(w.constructorArgs, ['N', 'S', 1000n, MINT_TO]);
  const c = tokenContractFor({ clones: true, args, creator: MINT_TO });
  assert.equal(c.contractName, 'ERC20Initializable');
});

test('buildWizardVerification: produces a blockscout standard-JSON request', () => {
  const buildInfo = loadBuildInfo(ERC20BASE_BUILDINFO);
  const payload = buildWizardVerification({
    address: TOKEN,
    buildInfo,
    contractName: 'ERC20Base',
    constructorArgs: ['Prana Gold', 'PGLD', 1000n, MINT_TO],
  });
  assert.equal(payload.addressHash, TOKEN);
  assert.equal(payload.compilerVersion, 'v0.8.24+commit.e11b9ed9');
  assert.equal(payload.contractName, 'contracts/ERC20Base.sol:ERC20Base');
  assert.ok(payload.standardJsonInput.sources);
  // constructor args are hex with no 0x prefix and ABI-decode back to the inputs
  assert.match(payload.constructorArguments, /^[0-9a-f]+$/);
  const decoded = AbiCoder.defaultAbiCoder().decode(
    ['string', 'string', 'uint256', 'address'],
    '0x' + payload.constructorArguments,
  );
  assert.equal(decoded[0], 'Prana Gold');
  assert.equal(decoded[2], 1000n);
  assert.equal(decoded[3], MINT_TO);
});
