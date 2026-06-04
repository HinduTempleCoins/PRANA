const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const CLAIM = ethers.encodeBytes32String("claim-1");
const MIN_STAKE = 1000n;

describe("TaskVerificationGate", function () {
  async function deployFixture() {
    const [admin, worker, a1, a2, a3, consumer, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Stake", "STK");

    const Attest = await ethers.getContractFactory("AttestationStakeSlash");
    const attest = await Attest.deploy(
      await token.getAddress(),
      MIN_STAKE,
      admin.address, // treasury
      admin.address
    );

    const Gate = await ethers.getContractFactory("TaskVerificationGate");
    const gate = await Gate.deploy(await attest.getAddress(), admin.address);
    await gate.grantRole(await gate.CONSUMER_ROLE(), consumer.address);

    // fund + stake a1,a2 active; a3 NOT staked (inactive)
    for (const a of [a1, a2, a3]) {
      await token.mint(a.address, 10000n);
      await token.connect(a).approve(await attest.getAddress(), 10000n);
    }
    await attest.connect(a1).stake(MIN_STAKE);
    await attest.connect(a2).stake(MIN_STAKE);

    return { attest, gate, token, admin, worker, a1, a2, a3, consumer, outsider };
  }

  async function openK2(ctx) {
    // K=2 of N=2 over {a1,a2}
    await ctx.gate.openClaim(CLAIM, ctx.worker.address, 2, [ctx.a1.address, ctx.a2.address]);
  }

  it("reverts on zero attestation module", async () => {
    const Gate = await ethers.getContractFactory("TaskVerificationGate");
    const [admin] = await ethers.getSigners();
    await expect(
      Gate.deploy(ethers.ZeroAddress, admin.address)
    ).to.be.revertedWithCustomError(Gate, "ZeroAttestation");
  });

  it("only CONFIG_ROLE opens claims; bad quorum / zero worker / dup rejected", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, worker, a1, a2, outsider } = ctx;
    await expect(
      gate.connect(outsider).openClaim(CLAIM, worker.address, 1, [a1.address])
    ).to.be.revertedWithCustomError(gate, "AccessControlUnauthorizedAccount");

    await expect(
      gate.openClaim(CLAIM, ethers.ZeroAddress, 1, [a1.address])
    ).to.be.revertedWithCustomError(gate, "ZeroWorker");

    // K > N
    await expect(
      gate.openClaim(CLAIM, worker.address, 3, [a1.address, a2.address])
    ).to.be.revertedWithCustomError(gate, "BadQuorum");

    await openK2(ctx);
    await expect(
      gate.openClaim(CLAIM, worker.address, 2, [a1.address, a2.address])
    ).to.be.revertedWithCustomError(gate, "ClaimExists");
  });

  it("verifies only after K distinct active attestations", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, worker, a1, a2 } = ctx;
    await openK2(ctx);

    expect(await gate.isVerified(CLAIM)).to.equal(false);

    await expect(gate.connect(a1).attest(CLAIM))
      .to.emit(gate, "Attested")
      .withArgs(CLAIM, a1.address, 1, 2);
    expect(await gate.isVerified(CLAIM)).to.equal(false);

    await expect(gate.connect(a2).attest(CLAIM))
      .to.emit(gate, "Attested")
      .withArgs(CLAIM, a2.address, 2, 2)
      .and.to.emit(gate, "Verified")
      .withArgs(CLAIM, worker.address);
    expect(await gate.isVerified(CLAIM)).to.equal(true);
  });

  it("rejects non-eligible, inactive, and double attestation", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, a1, a3, outsider } = ctx;
    await openK2(ctx);

    // a3 is in neither set -> NotEligible (and would also be inactive)
    await expect(gate.connect(outsider).attest(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "NotEligible"
    );

    // a1 eligible+active, attests once; second time -> AlreadyAttested
    await gate.connect(a1).attest(CLAIM);
    await expect(gate.connect(a1).attest(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "AlreadyAttested"
    );
  });

  it("eligible-but-unstaked attestor is rejected as not active", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, worker, a1, a3 } = ctx;
    // include a3 (eligible) but a3 never staked -> inactive
    await gate.openClaim(CLAIM, worker.address, 1, [a1.address, a3.address]);
    await expect(gate.connect(a3).attest(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "NotActiveAttestor"
    );
  });

  it("attest on unknown claim reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, a1 } = ctx;
    await expect(gate.connect(a1).attest(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "ClaimUnknown"
    );
  });

  it("consume is one-shot, role-gated, and only after verified", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, worker, a1, a2, consumer, outsider } = ctx;
    await openK2(ctx);

    // not verified yet
    await expect(gate.connect(consumer).consume(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "NotVerified"
    );

    await gate.connect(a1).attest(CLAIM);
    await gate.connect(a2).attest(CLAIM);

    // not the consumer role
    await expect(gate.connect(outsider).consume(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "AccessControlUnauthorizedAccount"
    );

    // staticCall returns a value (the worker), not a tx — a bare await fails the test if it reverts.
    await gate.connect(consumer).consume.staticCall(CLAIM);
    await expect(gate.connect(consumer).consume(CLAIM))
      .to.emit(gate, "Consumed")
      .withArgs(CLAIM, worker.address, consumer.address);

    // second consume blocked
    await expect(gate.connect(consumer).consume(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "AlreadyConsumed"
    );
  });

  it("workerOf / quorumOf expose state", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, worker, a1 } = ctx;
    await openK2(ctx);
    expect(await gate.workerOf(CLAIM)).to.equal(worker.address);
    await gate.connect(a1).attest(CLAIM);
    const [k, n, count, consumed] = await gate.quorumOf(CLAIM);
    expect(k).to.equal(2);
    expect(n).to.equal(2);
    expect(count).to.equal(1);
    expect(consumed).to.equal(false);
  });
});
