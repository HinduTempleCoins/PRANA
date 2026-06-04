const { expect } = require("chai");
const { ethers } = require("hardhat");

// Kind enum (must match ProofOfContributionRouter.Kind).
const Kind = { COMPUTE: 0, SOLAR: 1, CODE: 2 };
// Lane enum on the sink (Lane.TASK = 1).
const Lane = { HASH: 0, TASK: 1, BURN: 2 };

const WAD = 10n ** 18n;
const account = "0x00000000000000000000000000000000000000a1"; // lowercase address literal
const PROOF = ethers.id("proof-1");

describe("ProofOfContributionRouter (BI10 — SURYA glue)", function () {
  let router, source, sink, admin, relayer, outsider;

  function encode(acct, amount) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [acct, amount]);
  }

  beforeEach(async () => {
    [admin, relayer, outsider] = await ethers.getSigners();

    const Sink = await ethers.getContractFactory("MockSharesLedgerSink");
    sink = await Sink.deploy();

    const Src = await ethers.getContractFactory("MockContributionSource");
    source = await Src.deploy();

    const Router = await ethers.getContractFactory("ProofOfContributionRouter");
    router = await Router.deploy(await sink.getAddress(), admin.address);

    // Grant the relayer the ROUTER_ROLE.
    await router.grantRole(await router.ROUTER_ROLE(), relayer.address);
  });

  it("registers a source and emits SourceRegistered", async () => {
    await expect(router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD))
      .to.emit(router, "SourceRegistered")
      .withArgs(Kind.COMPUTE, await source.getAddress(), WAD);

    const s = await router.sources(Kind.COMPUTE);
    expect(s.adapter).to.equal(await source.getAddress());
    expect(s.weight).to.equal(WAD);
    expect(s.registered).to.equal(true);
  });

  it("routes a verified contribution → correct normalized credit into the TASK lane", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);

    const baseAmount = 500n;
    const data = encode(account, baseAmount);

    await expect(router.connect(relayer).route(Kind.COMPUTE, PROOF, data))
      .to.emit(router, "ContributionRouted")
      .withArgs(Kind.COMPUTE, PROOF, ethers.getAddress(account), baseAmount, WAD, baseAmount);

    // The sink received exactly one credit, in the TASK lane, for the normalized amount.
    expect(await sink.creditCount()).to.equal(1n);
    const [acct, lane, amount] = await sink.lastCredit();
    expect(acct).to.equal(ethers.getAddress(account));
    expect(lane).to.equal(Lane.TASK);
    expect(amount).to.equal(baseAmount);

    expect(await router.isRouted(Kind.COMPUTE, PROOF)).to.equal(true);
  });

  it("applies the per-source weight to the base amount", async () => {
    // weight = 2x.
    await router.registerSource(Kind.SOLAR, await source.getAddress(), 2n * WAD);
    const baseAmount = 300n;

    await expect(router.connect(relayer).route(Kind.SOLAR, PROOF, encode(account, baseAmount)))
      .to.emit(router, "ContributionRouted")
      .withArgs(Kind.SOLAR, PROOF, ethers.getAddress(account), baseAmount, 2n * WAD, 2n * baseAmount);

    const [, , amount] = await sink.lastCredit();
    expect(amount).to.equal(2n * baseAmount); // 300 * 2 = 600
  });

  it("dedup rejects a replay of the same proof", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);
    const data = encode(account, 100n);

    await router.connect(relayer).route(Kind.COMPUTE, PROOF, data);

    await expect(router.connect(relayer).route(Kind.COMPUTE, PROOF, data)).to.be.revertedWithCustomError(
      router,
      "AlreadyRouted",
    );
    // Still only one credit reached the sink.
    expect(await sink.creditCount()).to.equal(1n);
  });

  it("reverts routing an unregistered kind", async () => {
    // CODE never registered.
    await expect(
      router.connect(relayer).route(Kind.CODE, PROOF, encode(account, 1n)),
    ).to.be.revertedWithCustomError(router, "KindNotRegistered");
  });

  it("does not re-implement verification — propagates the adapter's revert (and does not mark routed)", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);
    await source.setRevert(true);

    await expect(
      router.connect(relayer).route(Kind.COMPUTE, PROOF, encode(account, 100n)),
    ).to.be.revertedWithCustomError(source, "NotVerified");

    // The route() tx reverted, so ALL of its state changes roll back — including the
    // routed[dedupKey]=true effect set before the external verify call (CEI guards reentrancy
    // within a call, not a top-level revert). So the proof is NOT marked routed and a genuine
    // retry of the same proofId is possible once the adapter verifies it.
    expect(await router.isRouted(Kind.COMPUTE, PROOF)).to.equal(false);
    expect(await sink.creditCount()).to.equal(0n);
  });

  it("only ROUTER_ROLE can route", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);
    await expect(
      router.connect(outsider).route(Kind.COMPUTE, PROOF, encode(account, 1n)),
    ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
  });

  it("only SOURCE_ADMIN_ROLE can register / remove sources", async () => {
    await expect(
      router.connect(outsider).registerSource(Kind.COMPUTE, await source.getAddress(), WAD),
    ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
  });

  it("rejects zero adapter and zero weight on register", async () => {
    await expect(
      router.registerSource(Kind.COMPUTE, ethers.ZeroAddress, WAD),
    ).to.be.revertedWithCustomError(router, "ZeroAddress");
    await expect(
      router.registerSource(Kind.COMPUTE, await source.getAddress(), 0n),
    ).to.be.revertedWithCustomError(router, "ZeroWeight");
  });

  it("removeSource disables routing and emits SourceRemoved", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);
    await expect(router.removeSource(Kind.COMPUTE))
      .to.emit(router, "SourceRemoved")
      .withArgs(Kind.COMPUTE, await source.getAddress());

    await expect(
      router.connect(relayer).route(Kind.COMPUTE, PROOF, encode(account, 1n)),
    ).to.be.revertedWithCustomError(router, "KindNotRegistered");
  });

  it("reverts when the adapter returns a zero account or zero base amount", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);

    await expect(
      router.connect(relayer).route(Kind.COMPUTE, ethers.id("p-zeroacct"), encode(ethers.ZeroAddress, 5n)),
    ).to.be.revertedWithCustomError(router, "ZeroAccount");

    await expect(
      router.connect(relayer).route(Kind.COMPUTE, ethers.id("p-zeroamt"), encode(account, 0n)),
    ).to.be.revertedWithCustomError(router, "ZeroBaseAmount");
  });

  it("reverts ZeroCredit when weight rounds the credit to nothing", async () => {
    // weight = 1 wei (1e-18 x); baseAmount = 1 → 1*1/1e18 = 0.
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), 1n);
    await expect(
      router.connect(relayer).route(Kind.COMPUTE, PROOF, encode(account, 1n)),
    ).to.be.revertedWithCustomError(router, "ZeroCredit");
  });

  it("routes the same proofId under two different kinds independently", async () => {
    await router.registerSource(Kind.COMPUTE, await source.getAddress(), WAD);
    await router.registerSource(Kind.SOLAR, await source.getAddress(), WAD);

    await router.connect(relayer).route(Kind.COMPUTE, PROOF, encode(account, 10n));
    // Same proofId, different kind → distinct dedup key → allowed.
    await router.connect(relayer).route(Kind.SOLAR, PROOF, encode(account, 20n));

    expect(await sink.creditCount()).to.equal(2n);
  });
});
