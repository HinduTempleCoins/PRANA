const { expect } = require("chai");
const { ethers } = require("hardhat");

// DataDAO — community-owned, licensable verified datasets.
// Records per-contribution provenance, escrows license payments, splits pro-rata to
// contributors by accumulated weight via a pull-payment (MasterChef-index) split.

describe("DataDAO", function () {
  const DATASET = 1n;
  const TERMS = ethers.keccak256(ethers.toUtf8Bytes("license-terms-v1"));
  const PRICE = 1_000_000n; // license price in pay-token units

  let dao, token, admin, curator, treasury, alice, bob, builder, stranger;

  beforeEach(async () => {
    [admin, curator, treasury, alice, bob, builder, stranger] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Pay", "PAY");

    const DAO = await ethers.getContractFactory("DataDAO");
    // 10% protocol cut to the treasury.
    dao = await DAO.deploy(admin.address, curator.address, treasury.address, 1000n);

    // Open a dataset paid in the ERC-20.
    await dao.connect(admin).createDataset(DATASET, await token.getAddress(), PRICE, TERMS);

    // Fund the builder/licensee.
    await token.mint(builder.address, 10n * PRICE);
    await token.connect(builder).approve(await dao.getAddress(), ethers.MaxUint256);
  });

  it("records provenance and exposes weight views", async () => {
    await dao.connect(curator).recordContribution(DATASET, alice.address, 60n, true);
    await dao.connect(curator).recordContribution(DATASET, bob.address, 40n, true);

    expect(await dao.contributionWeightOf(DATASET, alice.address)).to.equal(60n);
    expect(await dao.contributionWeightOf(DATASET, bob.address)).to.equal(40n);
    expect(await dao.totalWeight(DATASET)).to.equal(100n);
    expect(await dao.contributionCount()).to.equal(2n);

    const rec = await dao.contributions(0);
    expect(rec.contributor).to.equal(alice.address);
    expect(rec.weight).to.equal(60n);
    expect(rec.verifiedHuman).to.equal(true);
  });

  it("licenses a dataset and splits proceeds 60/40 minus protocol cut", async () => {
    await dao.connect(curator).recordContribution(DATASET, alice.address, 60n, true);
    await dao.connect(curator).recordContribution(DATASET, bob.address, 40n, true);

    await dao.connect(builder).license(DATASET);

    const tok = await token.getAddress();
    const cut = (PRICE * 1000n) / 10000n; // 10%
    const toSplit = PRICE - cut; // 900000
    const aliceShare = (toSplit * 60n) / 100n;
    const bobShare = (toSplit * 40n) / 100n;

    expect(await dao.claimable(DATASET, tok, alice.address)).to.equal(aliceShare);
    expect(await dao.claimable(DATASET, tok, bob.address)).to.equal(bobShare);
    expect(await dao.protocolFees(tok)).to.equal(cut);

    await dao.connect(alice).claim(DATASET, tok, alice.address);
    await dao.connect(bob).claim(DATASET, tok, bob.address);

    expect(await token.balanceOf(alice.address)).to.equal(aliceShare);
    expect(await token.balanceOf(bob.address)).to.equal(bobShare);

    // Treasury pulls the protocol cut.
    await dao.connect(admin).withdrawProtocolFees(tok);
    expect(await token.balanceOf(treasury.address)).to.equal(cut);
  });

  it("reverts on a double-claim", async () => {
    await dao.connect(curator).recordContribution(DATASET, alice.address, 60n, true);
    await dao.connect(curator).recordContribution(DATASET, bob.address, 40n, true);
    await dao.connect(builder).license(DATASET);

    const tok = await token.getAddress();
    await dao.connect(alice).claim(DATASET, tok, alice.address);
    await expect(dao.connect(alice).claim(DATASET, tok, alice.address)).to.be.revertedWithCustomError(
      dao,
      "NothingToClaim"
    );
  });

  it("reverts when a non-curator tries to record", async () => {
    await expect(
      dao.connect(stranger).recordContribution(DATASET, alice.address, 10n, true)
    ).to.be.revertedWithCustomError(dao, "AccessControlUnauthorizedAccount");
  });

  it("reverts when licensing an unknown dataset", async () => {
    await expect(dao.connect(builder).license(999n)).to.be.revertedWithCustomError(dao, "UnknownDataset");
  });

  it("late contributor only shares in licenses sold after they joined", async () => {
    const tok = await token.getAddress();
    // alice contributes, dataset licensed once with only alice present.
    await dao.connect(curator).recordContribution(DATASET, alice.address, 100n, true);
    await dao.connect(builder).license(DATASET);

    const cut = (PRICE * 1000n) / 10000n;
    const toSplit = PRICE - cut;
    // alice owns the whole first license's split.
    expect(await dao.claimable(DATASET, tok, alice.address)).to.equal(toSplit);

    // bob joins late with equal weight, then a second license sells.
    await dao.connect(curator).recordContribution(DATASET, bob.address, 100n, true);
    await dao.connect(builder).license(DATASET);

    // Second license splits 50/50; bob shares only in the second.
    expect(await dao.claimable(DATASET, tok, bob.address)).to.equal(toSplit / 2n);
    expect(await dao.claimable(DATASET, tok, alice.address)).to.equal(toSplit + toSplit / 2n);
  });

  it("supports native-PRANA datasets and pays out native pro-rata", async () => {
    const NATIVE = ethers.ZeroAddress;
    const NPRICE = ethers.parseEther("1");
    const ND = 2n;
    await dao.connect(admin).createDataset(ND, NATIVE, NPRICE, TERMS);
    await dao.connect(curator).recordContribution(ND, alice.address, 60n, true);
    await dao.connect(curator).recordContribution(ND, bob.address, 40n, true);

    await dao.connect(builder).license(ND, { value: NPRICE });

    const cut = (NPRICE * 1000n) / 10000n;
    const toSplit = NPRICE - cut;
    expect(await dao.claimable(ND, NATIVE, alice.address)).to.equal((toSplit * 60n) / 100n);

    const before = await ethers.provider.getBalance(bob.address);
    // stranger triggers bob's claim; funds go to bob regardless of caller.
    await dao.connect(stranger).claim(ND, NATIVE, bob.address);
    const after = await ethers.provider.getBalance(bob.address);
    expect(after - before).to.equal((toSplit * 40n) / 100n);
  });

  it("rejects wrong native payment amount", async () => {
    const NATIVE = ethers.ZeroAddress;
    const NPRICE = ethers.parseEther("1");
    const ND = 3n;
    await dao.connect(admin).createDataset(ND, NATIVE, NPRICE, TERMS);
    await dao.connect(curator).recordContribution(ND, alice.address, 1n, true);
    await expect(
      dao.connect(builder).license(ND, { value: NPRICE - 1n })
    ).to.be.revertedWithCustomError(dao, "WrongPayment");
  });

  it("cross-checks verifiedHuman against the oracle when set", async () => {
    const Verifier = await ethers.getContractFactory("MockHumanVerifier");
    const verifier = await Verifier.deploy();
    await verifier.setVerified(alice.address, true);
    await dao.connect(admin).setHumanVerifier(await verifier.getAddress());

    // alice is verified — passes.
    await dao.connect(curator).recordContribution(DATASET, alice.address, 10n, true);
    // bob is NOT verified but the curator claims verifiedHuman — rejected.
    await expect(
      dao.connect(curator).recordContribution(DATASET, bob.address, 10n, true)
    ).to.be.revertedWithCustomError(dao, "NotVerifiedHuman");
    // bob recorded as NON-human is allowed (flag false skips the check).
    await dao.connect(curator).recordContribution(DATASET, bob.address, 10n, false);
    expect(await dao.contributionWeightOf(DATASET, bob.address)).to.equal(10n);
  });
});
