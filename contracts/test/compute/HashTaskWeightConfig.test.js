const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Lane enum (matches IUnifiedSharesLedger.Lane): HASH=0, TASK=1, BURN=2
const HASH = 0;
const TASK = 1;
const BURN = 2;
const ONE = 10n ** 18n;

describe("HashTaskWeightConfig (NN5)", function () {
  async function deploy() {
    const [admin, gov, other] = await ethers.getSigners();
    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    // burnWeight = 0.5x, vardiff [100, 10000]
    const cfg = await Cfg.deploy(admin.address, ONE / 2n, 100n, 10_000n);
    return { admin, gov, other, cfg };
  }

  it("defaults HASH and TASK to 1e18 (seamless switching) and BURN to constructor value", async () => {
    const { cfg } = await loadFixture(deploy);
    expect(await cfg.laneWeight(HASH)).to.equal(ONE);
    expect(await cfg.laneWeight(TASK)).to.equal(ONE);
    expect(await cfg.laneWeight(BURN)).to.equal(ONE / 2n);
  });

  it("stores vardiff bounds for the off-chain coordinator", async () => {
    const { cfg } = await loadFixture(deploy);
    expect(await cfg.minDifficulty()).to.equal(100n);
    expect(await cfg.maxDifficulty()).to.equal(10_000n);
  });

  it("WEIGHT_ADMIN can change a lane weight and emits", async () => {
    const { admin, cfg } = await loadFixture(deploy);
    await expect(cfg.connect(admin).setLaneWeight(TASK, 2n * ONE))
      .to.emit(cfg, "LaneWeightSet")
      .withArgs(TASK, 2n * ONE);
    expect(await cfg.laneWeight(TASK)).to.equal(2n * ONE);
  });

  it("non-admin cannot set lane weight", async () => {
    const { other, cfg } = await loadFixture(deploy);
    await expect(cfg.connect(other).setLaneWeight(HASH, ONE)).to.be.reverted;
  });

  it("can update vardiff bounds and rejects inverted bounds", async () => {
    const { admin, cfg } = await loadFixture(deploy);
    await expect(cfg.connect(admin).setVardiffBounds(50n, 500n))
      .to.emit(cfg, "VardiffBoundsSet")
      .withArgs(50n, 500n);
    expect(await cfg.minDifficulty()).to.equal(50n);
    expect(await cfg.maxDifficulty()).to.equal(500n);

    await expect(cfg.connect(admin).setVardiffBounds(500n, 50n)).to.be.revertedWithCustomError(
      cfg,
      "InvalidVardiffBounds"
    );
  });

  it("constructor rejects inverted vardiff bounds", async () => {
    const [admin] = await ethers.getSigners();
    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    await expect(Cfg.deploy(admin.address, ONE, 1000n, 10n)).to.be.revertedWithCustomError(
      Cfg,
      "InvalidVardiffBounds"
    );
  });

  it("admin can grant WEIGHT_ADMIN_ROLE to the DAO", async () => {
    const { admin, gov, cfg } = await loadFixture(deploy);
    const role = await cfg.WEIGHT_ADMIN_ROLE();
    await cfg.connect(admin).grantRole(role, gov.address);
    await expect(cfg.connect(gov).setLaneWeight(BURN, ONE)).to.emit(cfg, "LaneWeightSet").withArgs(BURN, ONE);
  });
});
