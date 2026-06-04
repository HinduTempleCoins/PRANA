import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface } from 'ethers';

import {
  loadBuildInfo,
  buildVerificationPayload,
  encodeConstructorArgs,
} from '../lib/verification-helper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_INFO_DIR = path.resolve(__dirname, '../../contracts/artifacts/build-info');

// Pick the newest build-info file (by mtime) — read-only.
function newestBuildInfoPath() {
  const files = fs
    .readdirSync(BUILD_INFO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(BUILD_INFO_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  assert.ok(files.length > 0, 'expected at least one build-info file');
  return files[0].full;
}

// Find a contract compiled in this build-info that lives under contracts/ (not an interface).
function pickContract(buildInfo) {
  const out = buildInfo.output.contracts;
  for (const [srcPath, contracts] of Object.entries(out)) {
    if (!srcPath.startsWith('contracts/') || srcPath.includes('interfaces/')) continue;
    for (const [name, def] of Object.entries(contracts)) {
      const ctor = (def.abi || []).find((x) => x.type === 'constructor');
      return { srcPath, name, abi: def.abi, ctor };
    }
  }
  throw new Error('no suitable contract found in newest build-info');
}

test('loadBuildInfo reads + parses a real Hardhat build-info', () => {
  const bi = loadBuildInfo(newestBuildInfoPath());
  assert.ok(bi.input && bi.input.sources, 'has standard-JSON input.sources');
  assert.equal(bi.input.language, 'Solidity');
  assert.ok(bi.solcLongVersion, 'has a long compiler version');
});

test('loadBuildInfo rejects a non-build-info JSON', () => {
  const f = path.join(process.env.TMPDIR || '/tmp', `notbuildinfo-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ hello: 'world' }));
  try {
    assert.throws(() => loadBuildInfo(f), /not a Hardhat build-info/);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test('encodeConstructorArgs returns "" for no-arg constructor', () => {
  const abi = [{ type: 'constructor', inputs: [], stateMutability: 'nonpayable' }];
  assert.equal(encodeConstructorArgs(abi, []), '');
});

test('encodeConstructorArgs matches ethers Interface.encodeDeploy (no 0x prefix)', () => {
  const abi = [
    { type: 'constructor', inputs: [{ name: 'a', type: 'uint256' }], stateMutability: 'nonpayable' },
  ];
  const hex = encodeConstructorArgs(abi, [42n]);
  const expected = new Interface(abi).encodeDeploy([42n]).slice(2);
  assert.equal(hex, expected);
  assert.match(hex, /^[0-9a-f]+$/);
});

test('buildVerificationPayload against the newest real build-info', () => {
  const biPath = newestBuildInfoPath();
  const buildInfo = loadBuildInfo(biPath);
  const picked = pickContract(buildInfo);

  // Construct args matching the real constructor signature (zero-fill).
  const args = (picked.ctor?.inputs || []).map((inp) => {
    if (inp.type === 'address') return '0x0000000000000000000000000000000000000001';
    if (inp.type.startsWith('uint') || inp.type.startsWith('int')) return 0n;
    if (inp.type === 'bool') return false;
    if (inp.type === 'string') return '';
    if (inp.type === 'bytes') return '0x';
    throw new Error(`unhandled ctor arg type ${inp.type}`);
  });

  const payload = buildVerificationPayload({
    contractName: picked.name,
    address: '0x000000000000000000000000000000000000dEaD',
    constructorArgs: args,
    buildInfo,
  });

  // compilerVersion shape: v<major>.<minor>.<patch>+commit.<hash>
  assert.match(payload.compilerVersion, /^v\d+\.\d+\.\d+\+commit\.[0-9a-f]+$/);

  // standardJsonInput.sources contains the contract's own source path.
  assert.ok(payload.standardJsonInput.sources, 'standardJsonInput.sources present');
  assert.ok(
    Object.prototype.hasOwnProperty.call(payload.standardJsonInput.sources, picked.srcPath),
    `sources should include ${picked.srcPath}`,
  );

  // contractPath is the fully-qualified "<path>:<Name>".
  assert.equal(payload.contractPath, `${picked.srcPath}:${picked.name}`);

  // constructorArgsHex equals an independent ethers encode (no 0x).
  const expectedHex =
    args.length === 0 ? '' : new Interface(picked.abi).encodeDeploy(args).slice(2);
  assert.equal(payload.constructorArgsHex, expectedHex);

  // address passes through.
  assert.equal(payload.address, '0x000000000000000000000000000000000000dEaD');
});

test('buildVerificationPayload errors clearly on unknown contract name', () => {
  const buildInfo = loadBuildInfo(newestBuildInfoPath());
  assert.throws(
    () => buildVerificationPayload({ contractName: 'NoSuchContractXYZ', address: '0x1', buildInfo }),
    /not found in build-info output/,
  );
});
