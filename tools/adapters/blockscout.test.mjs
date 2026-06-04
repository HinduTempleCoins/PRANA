// W8 — blockscout.mjs tests. Payload-build + build-info extraction; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildStandardJsonVerification,
  extractStandardInput,
  readBuildInfoStandardInput,
  submitVerification,
  checkStatus,
  BlockscoutHttpError,
} from "./blockscout.mjs";

const ADDR = "0x" + "ab".repeat(20);

test("buildStandardJsonVerification produces standard-input request shape", () => {
  const { address, body } = buildStandardJsonVerification({
    address: ADDR,
    contractName: "contracts/Token.sol:Token",
    compilerVersion: "0.8.24+commit.e11b9ed9",
    standardJsonInput: { language: "Solidity", sources: {}, settings: {} },
    constructorArgs: ["00aa", "bb"],
  });
  assert.equal(address, ADDR);
  assert.equal(body.compiler_version, "v0.8.24+commit.e11b9ed9"); // v-prefixed
  assert.equal(body.contract_name, "contracts/Token.sol:Token");
  assert.ok(body.files["standard-input.json"]);
  const parsed = JSON.parse(body.files["standard-input.json"]);
  assert.equal(parsed.language, "Solidity");
  assert.equal(body.constructor_args, "00aabb"); // concatenated
});

test("buildStandardJsonVerification accepts string standardJsonInput", () => {
  const { body } = buildStandardJsonVerification({
    address: ADDR,
    contractName: "X",
    compilerVersion: "v0.8.24+commit.e11b9ed9",
    standardJsonInput: '{"language":"Solidity"}',
  });
  assert.equal(body.files["standard-input.json"], '{"language":"Solidity"}');
});

test("buildStandardJsonVerification supports autodetect constructor args", () => {
  const { body } = buildStandardJsonVerification({
    address: ADDR,
    contractName: "X",
    compilerVersion: "0.8.24",
    standardJsonInput: { language: "Solidity" },
    autodetectConstructorArgs: true,
  });
  assert.equal(body.autodetect_constructor_args, true);
  assert.equal("constructor_args" in body, false);
});

test("buildStandardJsonVerification validates address", () => {
  assert.throws(
    () =>
      buildStandardJsonVerification({
        address: "0xnotanaddress",
        contractName: "X",
        compilerVersion: "0.8.24",
        standardJsonInput: {},
      }),
    /40-hex/
  );
});

test("extractStandardInput pulls solc standard input from build-info shape", () => {
  const buildInfo = {
    _format: "hh-sol-build-info-1",
    solcVersion: "0.8.24",
    solcLongVersion: "0.8.24+commit.e11b9ed9",
    input: { language: "Solidity", sources: { "A.sol": { content: "x" } }, settings: {} },
    output: {},
  };
  const out = extractStandardInput(buildInfo);
  assert.equal(out.standardJsonInput.language, "Solidity");
  assert.equal(out.compilerVersion, "v0.8.24+commit.e11b9ed9");
  assert.equal(out.solcVersion, "0.8.24");
});

test("extractStandardInput rejects non-Solidity input", () => {
  assert.throws(() => extractStandardInput({ input: { language: "Vyper" } }), /Standard JSON Input/);
});

test("readBuildInfoStandardInput reads a REAL hardhat build-info file", async () => {
  const dir = path.resolve(import.meta.dirname, "../../contracts/artifacts/build-info");
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    // build artifacts not present in this checkout — skip gracefully.
    return;
  }
  if (files.length === 0) return;
  const out = await readBuildInfoStandardInput(path.join(dir, files[0]));
  assert.equal(out.standardJsonInput.language, "Solidity");
  assert.ok(out.compilerVersion.startsWith("v"));
  assert.ok(Object.keys(out.standardJsonInput.sources).length > 0);
  // Round-trips into a verification request.
  const { body } = buildStandardJsonVerification({
    address: ADDR,
    contractName: "contracts/Some.sol:Some",
    compilerVersion: out.compilerVersion,
    standardJsonInput: out.standardJsonInput,
  });
  assert.ok(JSON.parse(body.files["standard-input.json"]).sources);
});

test("submitVerification fixture mode returns ack without network", async () => {
  const r = await submitVerification(
    {
      address: ADDR,
      contractName: "X",
      compilerVersion: "0.8.24",
      standardJsonInput: { language: "Solidity" },
    },
    { fixture: { message: "Verification started", status: "0" } }
  );
  assert.equal(r.message, "Verification started");
});

test("checkStatus maps is_verified (injected fetch)", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/smart-contracts\/0x/);
    return { ok: true, status: 200, text: async () => JSON.stringify({ is_verified: true }) };
  };
  const r = await checkStatus(ADDR, { fetchImpl });
  assert.equal(r.isVerified, true);
});

test("checkStatus surfaces HTTP errors", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ message: "not found" }),
  });
  await assert.rejects(
    () => checkStatus(ADDR, { fetchImpl }),
    (e) => e instanceof BlockscoutHttpError && e.status === 404
  );
});
