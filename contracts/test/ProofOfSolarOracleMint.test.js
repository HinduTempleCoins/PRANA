const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProofOfSolarOracleMint", function () {
  let reward, solar, admin, producer, outsider;
  const RATE = 5n;          // 5 tokens per kWh
  const CAP = 1000n;        // kWh per period
  const PERIOD = 100000;

  beforeEach(async () => {
    [admin, producer, outsider] = await ethers.getSigners();
    const PoL = await ethers.getContractFactory("PoLToken");
    reward = await PoL.deploy(admin.address);
    const S = await ethers.getContractFactory("ProofOfSolarOracleMint");
    solar = await S.deploy(await reward.getAddress(), RATE, CAP, PERIOD, admin.address);
    // the oracle must be allowed to mint the reward token
    await reward.grantRole(await reward.MINTER_ROLE(), await solar.getAddress());
  });

  it("mints on attested kWh at the configured rate", async () => {
    const proof = ethers.encodeBytes32String("meter-1");
    await expect(solar.attest(producer.address, 200n, proof))
      .to.emit(solar, "SolarMinted")
      .withArgs(producer.address, 200n, 1000n, proof);
    expect(await reward.balanceOf(producer.address)).to.equal(1000n); // 200 * 5
  });

  it("rejects a reused proof", async () => {
    const proof = ethers.encodeBytes32String("meter-1");
    await solar.attest(producer.address, 10n, proof);
    await expect(solar.attest(producer.address, 10n, proof)).to.be.revertedWith("proof used");
  });

  it("enforces the per-period cap", async () => {
    await solar.attest(producer.address, 1000n, ethers.encodeBytes32String("a"));
    await expect(
      solar.attest(producer.address, 1n, ethers.encodeBytes32String("b"))
    ).to.be.revertedWith("period cap");
  });

  it("only an attestor can attest", async () => {
    await expect(
      solar.connect(outsider).attest(producer.address, 1n, ethers.encodeBytes32String("c"))
    ).to.be.reverted;
  });
});
