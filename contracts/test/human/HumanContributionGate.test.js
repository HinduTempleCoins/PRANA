const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const CLAIM = ethers.encodeBytes32String("hclaim-1");
const MIN_STAKE = 1000n;
const BASE = 100n;

describe("HumanContributionGate (AG4)", function () {
  async function deployFixture() {
    const [admin, contributor, l1, l2, l3, checker, consumer, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Stake", "STK");

    const Attest = await ethers.getContractFactory("AttestationStakeSlash");
    const attest = await Attest.deploy(await token.getAddress(), MIN_STAKE, admin.address, admin.address);

    const Gate = await ethers.getContractFactory("HumanContributionGate");
    const gate = await Gate.deploy(await attest.getAddress(), admin.address);
    await gate.grantRole(await gate.CONSUMER_ROLE(), consumer.address);
    await gate.grantRole(await gate.CHECKER_ROLE(), checker.address);

    // stake l1,l2 active; l3 inactive
    for (const a of [l1, l2, l3]) {
      await token.mint(a.address, 10000n);
      await token.connect(a).approve(await attest.getAddress(), 10000n);
    }
    await attest.connect(l1).stake(MIN_STAKE);
    await attest.connect(l2).stake(MIN_STAKE);

    return { attest, gate, token, admin, contributor, l1, l2, l3, checker, consumer, outsider };
  }

  async function openK2(ctx) {
    await ctx.gate.openClaim(CLAIM, ctx.contributor.address, BASE, 2, [ctx.l1.address, ctx.l2.address]);
  }

  it("reverts on zero attestation module", async () => {
    const Gate = await ethers.getContractFactory("HumanContributionGate");
    const [admin] = await ethers.getSigners();
    await expect(Gate.deploy(ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(
      Gate,
      "ZeroAttestation"
    );
  });

  it("only CONFIG opens claims; zero contributor / zero base / bad quorum / dup rejected", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, contributor, l1, l2, outsider } = ctx;
    await expect(
      gate.connect(outsider).openClaim(CLAIM, contributor.address, BASE, 1, [l1.address])
    ).to.be.revertedWithCustomError(gate, "AccessControlUnauthorizedAccount");
    await expect(
      gate.openClaim(CLAIM, ethers.ZeroAddress, BASE, 1, [l1.address])
    ).to.be.revertedWithCustomError(gate, "ZeroContributor");
    await expect(
      gate.openClaim(CLAIM, contributor.address, 0n, 1, [l1.address])
    ).to.be.revertedWithCustomError(gate, "ZeroBaseShares");
    await expect(
      gate.openClaim(CLAIM, contributor.address, BASE, 3, [l1.address, l2.address])
    ).to.be.revertedWithCustomError(gate, "BadQuorum");

    await openK2(ctx);
    await expect(
      gate.openClaim(CLAIM, contributor.address, BASE, 2, [l1.address, l2.address])
    ).to.be.revertedWithCustomError(gate, "ClaimExists");
  });

  it("requires quorum AND gold AND attention to verify", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, contributor, l1, l2, checker } = ctx;
    await openK2(ctx);
    expect(await gate.isVerified(CLAIM)).to.equal(false);

    await gate.connect(l1).attest(CLAIM);
    await gate.connect(l2).attest(CLAIM); // quorum reached but checks not yet
    expect(await gate.isVerified(CLAIM)).to.equal(false);

    await gate.connect(checker).setGoldPassed(CLAIM, true);
    expect(await gate.isVerified(CLAIM)).to.equal(false); // attention still missing

    await expect(gate.connect(checker).setAttentionPassed(CLAIM, true))
      .to.emit(gate, "Verified")
      .withArgs(CLAIM, contributor.address);
    expect(await gate.isVerified(CLAIM)).to.equal(true);
  });

  it("verified emits when the final attestation crosses K after checks already set", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, contributor, l1, l2, checker } = ctx;
    await openK2(ctx);
    await gate.connect(checker).setGoldPassed(CLAIM, true);
    await gate.connect(checker).setAttentionPassed(CLAIM, true);
    await gate.connect(l1).attest(CLAIM);
    await expect(gate.connect(l2).attest(CLAIM)).to.emit(gate, "Verified").withArgs(CLAIM, contributor.address);
  });

  it("rejects non-eligible, inactive, double attestation, unknown claim", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, contributor, l1, l3, outsider } = ctx;
    await expect(gate.connect(l1).attest(CLAIM)).to.be.revertedWithCustomError(gate, "ClaimUnknown");
    await openK2(ctx);
    await expect(gate.connect(outsider).attest(CLAIM)).to.be.revertedWithCustomError(gate, "NotEligible");

    // include l3 (eligible) but unstaked -> NotActiveLabeler
    const CLAIM2 = ethers.encodeBytes32String("hclaim-2");
    await gate.openClaim(CLAIM2, contributor.address, BASE, 1, [l1.address, l3.address]);
    await expect(gate.connect(l3).attest(CLAIM2)).to.be.revertedWithCustomError(gate, "NotActiveLabeler");

    await gate.connect(l1).attest(CLAIM);
    await expect(gate.connect(l1).attest(CLAIM)).to.be.revertedWithCustomError(gate, "AlreadyAttested");
  });

  it("checker setters revert on unknown claim and are role-gated", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, outsider } = ctx;
    await expect(gate.setGoldPassed(CLAIM, true)).to.be.revertedWithCustomError(gate, "ClaimUnknown");
    await openK2(ctx);
    await expect(gate.connect(outsider).setGoldPassed(CLAIM, true)).to.be.revertedWithCustomError(
      gate,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("consume is one-shot, role-gated, only after fully verified; returns (contributor, baseShares)", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, contributor, l1, l2, checker, consumer, outsider } = ctx;
    await openK2(ctx);

    await expect(gate.connect(consumer).consume(CLAIM)).to.be.revertedWithCustomError(gate, "NotVerified");

    await gate.connect(l1).attest(CLAIM);
    await gate.connect(l2).attest(CLAIM);
    await gate.connect(checker).setGoldPassed(CLAIM, true);
    await gate.connect(checker).setAttentionPassed(CLAIM, true);

    await expect(gate.connect(outsider).consume(CLAIM)).to.be.revertedWithCustomError(
      gate,
      "AccessControlUnauthorizedAccount"
    );

    const res = await gate.connect(consumer).consume.staticCall(CLAIM);
    expect(res[0]).to.equal(contributor.address);
    expect(res[1]).to.equal(BASE);

    await expect(gate.connect(consumer).consume(CLAIM))
      .to.emit(gate, "Consumed")
      .withArgs(CLAIM, contributor.address, consumer.address);

    await expect(gate.connect(consumer).consume(CLAIM)).to.be.revertedWithCustomError(gate, "AlreadyConsumed");
  });

  it("claimState exposes the snapshot", async () => {
    const ctx = await loadFixture(deployFixture);
    const { gate, contributor, l1 } = ctx;
    await openK2(ctx);
    await gate.connect(l1).attest(CLAIM);
    const s = await gate.claimState(CLAIM);
    expect(s.contributor).to.equal(contributor.address);
    expect(s.baseShares).to.equal(BASE);
    expect(s.k).to.equal(2);
    expect(s.n).to.equal(2);
    expect(s.count).to.equal(1);
    expect(s.goldPassed).to.equal(false);
    expect(s.attentionPassed).to.equal(false);
    expect(s.consumed).to.equal(false);
  });
});
