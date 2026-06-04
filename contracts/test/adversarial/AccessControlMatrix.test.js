const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Access-control matrix — adversarial sweep.
 *
 * For every role-gated / onlyOwner state-changing function across the most-privileged
 * contracts, assert it REVERTS when called by an unprivileged account (`attacker`).
 *
 * The whole suite is data-driven: each entry in CASES is
 *   { contract, deployArgs, fns: [{ name, args }] }
 * where deployArgs is a function (ctx) => [...] resolved per-fixture (so we can plug in
 * freshly-deployed dependency addresses and signer addresses). Adding a new contract or a
 * new gated function is a one-line edit — no new `it` blocks.
 *
 * Privileged roles are granted to `admin` (the deployer) at construction; `attacker` holds
 * nothing. We deliberately assert only `.to.be.reverted` (not a specific selector) because
 * the contracts mix OZ AccessControl custom errors, Ownable-style `require` strings, and
 * bespoke `require(msg.sender == x)` guards — the invariant under test is simply "an
 * unprivileged caller cannot".
 */
describe("Adversarial: access-control matrix (unprivileged callers are rejected)", function () {
  // A throwaway non-zero address for args that just need "some address".
  const SOME = "0x000000000000000000000000000000000000dEaD";
  const SELECTOR = "0x12345678";

  // Helper: deploy a fresh MockERC20 and return its address (string).
  async function mockToken(name, sym) {
    const Mock = await ethers.getContractFactory("MockERC20");
    const t = await Mock.deploy(name, sym);
    return await t.getAddress();
  }

  // ctx passed to deployArgs/fns: { admin, attacker, mock(name,sym), polAddr, ve, ... }
  const CASES = [
    {
      contract: "PoLToken",
      deployArgs: (c) => [c.admin.address],
      fns: [{ name: "mint", args: (c) => [c.attacker.address, 1n] }],
    },
    {
      contract: "GovernanceToken",
      deployArgs: (c) => ["Gov", "GOV", c.admin.address],
      fns: [{ name: "mint", args: (c) => [c.attacker.address, 1n] }],
    },
    {
      contract: "UtilityToken",
      deployArgs: (c) => ["Util", "UTL", c.admin.address],
      fns: [
        { name: "mint", args: (c) => [c.attacker.address, 1n] },
        // consume is SPENDER_ROLE-gated
        { name: "consume", args: (c) => [c.attacker.address, 1n] },
      ],
    },
    {
      contract: "ERC20Base",
      deployArgs: (c) => ["Base", "BASE", 1_000_000n * 10n ** 18n, c.admin.address],
      fns: [
        { name: "mint", args: (c) => [c.attacker.address, 1n] },
        { name: "pause", args: () => [] },
        { name: "unpause", args: () => [] },
      ],
    },
    {
      contract: "PranaNFT",
      deployArgs: (c) => [c.admin.address],
      fns: [{ name: "mint", args: (c) => [c.attacker.address, "ipfs://x"] }],
    },
    {
      contract: "SimplePriceOracle",
      deployArgs: (c) => [c.admin.address],
      fns: [{ name: "setPrice", args: () => [SOME, 1n] }],
    },
    {
      // SupplyController: token, capPerEpoch, epochLength, admin
      contract: "SupplyController",
      deployArgs: async (c) => [await c.polAddr(), 1000n, 100, c.admin.address],
      fns: [{ name: "mintCapped", args: (c) => [c.attacker.address, 1n] }],
    },
    {
      // ProofOfSolarOracleMint: rewardToken, ratePerKwh, periodCapKwh, periodLength, admin
      contract: "ProofOfSolarOracleMint",
      deployArgs: async (c) => [await c.polAddr(), 1n, 1000n, 100, c.admin.address],
      fns: [{ name: "attest", args: (c) => [c.attacker.address, 1n, ethers.ZeroHash] }],
    },
    {
      // SeasonPass: rewardToken, thresholds[], rewards[], admin
      contract: "SeasonPass",
      deployArgs: async (c) => [await c.mockToken("R", "R"), [10n], [1n], c.admin.address],
      fns: [
        { name: "addXp", args: (c) => [c.attacker.address, 1n] },
        { name: "startNewSeason", args: () => [[10n], [1n]] },
      ],
    },
    {
      // GachaMint: name, symbol, payToken, price, treasury, names[], weights[], pity, admin
      // GachaMint exposes ADMIN_ROLE but no admin-only mutators beyond role admin; included
      // here for the DEFAULT_ADMIN role-management surface (grantRole gated by AccessControl).
      contract: "GachaMint",
      deployArgs: async (c) => [
        "G", "G", await c.mockToken("P", "P"), 0n, SOME, ["C"], [1n], 0n, c.admin.address,
      ],
      fns: [
        // grantRole is itself DEFAULT_ADMIN_ROLE-gated (OZ AccessControl).
        {
          name: "grantRole",
          args: (c) => [ethers.id("ADMIN_ROLE"), c.attacker.address],
        },
      ],
    },
    {
      // MultiSigWallet: owners[], threshold  — onlyOwner submit/confirm/execute
      contract: "MultiSigWallet",
      deployArgs: (c) => [[c.admin.address], 1],
      fns: [
        { name: "submit", args: () => [SOME, 0n, "0x"] },
        { name: "confirm", args: () => [0n] },
        { name: "execute", args: () => [0n] },
      ],
    },
  ];

  // Build a fresh context (signers + dependency factories) for a given test.
  async function makeCtx() {
    const [admin, attacker] = await ethers.getSigners();
    return {
      admin,
      attacker,
      mockToken,
      // a deployed PoLToken address (used where an IMintable dependency is needed)
      polAddr: async () => {
        const PoL = await ethers.getContractFactory("PoLToken");
        const p = await PoL.deploy(admin.address);
        return await p.getAddress();
      },
    };
  }

  let totalChecks = 0;

  for (const cse of CASES) {
    describe(cse.contract, function () {
      for (const fn of cse.fns) {
        it(`${fn.name}() reverts for an unprivileged caller`, async function () {
          const ctx = await makeCtx();
          const Factory = await ethers.getContractFactory(cse.contract);
          const args = await cse.deployArgs(ctx);
          const inst = await Factory.deploy(...args);
          const callArgs = await fn.args(ctx);
          await expect(
            inst.connect(ctx.attacker)[fn.name](...callArgs)
          ).to.be.reverted;
          totalChecks++;
        });
      }
    });
  }

  // GaugeController is intentionally permissionless: addGauge() has NO access gate (anyone
  // may register a gauge) and vote() is gated by ve-weight, not a role. EmissionScheduler,
  // BurnMine, AccessGate, UsageBurn, FeeCollectorBurner, SessionKeyGrant, TimelockVault,
  // VestingFactory, ERC20FactoryWizard and MineableERC20 are by-design admin-less (immutable
  // or self-scoped per msg.sender), so there is no onlyOwner/role surface to sweep on them.
  // Documented here so the gap is explicit rather than silently omitted.
  describe("permissionless-by-design (documented, no gate to assert)", function () {
    it("GaugeController.addGauge has no owner/role gate (anyone may add a gauge)", async function () {
      const [admin, attacker] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const tok = await Mock.deploy("ve", "VE");
      const VE = await ethers.getContractFactory("VoteEscrow");
      const ve = await VE.deploy(await tok.getAddress(), 365 * 24 * 3600);
      const GC = await ethers.getContractFactory("GaugeController");
      const gc = await GC.deploy(await ve.getAddress());
      // An unprivileged account CAN add a gauge — confirms there is no gate (no revert).
      await expect(gc.connect(attacker).addGauge(SOME)).to.not.be.reverted;
    });
  });
});
