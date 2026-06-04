const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("GachaMintOnCommit", function () {
  const PRICE = ethers.parseEther("10");
  const NAMES = ["Common", "Rare", "Legendary"];
  const WEIGHTS = [70n, 25n, 5n];
  const PITY = 0; // disabled for deterministic odds tests

  // single-arg commit overload selector
  const COMMIT1 = "commit(bytes32)";

  function saltHash(salt) {
    return ethers.keccak256(
      ethers.solidityPacked(["bytes32"], [salt])
    );
  }

  async function deployFixture() {
    const [admin, treasury, user, relayer, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const pay = await MockERC20.deploy("Pay", "PAY");
    await pay.waitForDeployment();

    const Gacha = await ethers.getContractFactory("GachaMintOnCommit");
    const gacha = await Gacha.deploy(
      "Gacha NFT",
      "GACHA",
      await pay.getAddress(),
      PRICE,
      treasury.address,
      NAMES,
      WEIGHTS,
      PITY,
      admin.address
    );
    await gacha.waitForDeployment();

    const addr = await gacha.getAddress();
    for (const s of [user, relayer, other]) {
      await pay.mint(s.address, ethers.parseEther("100000"));
      await pay.connect(s).approve(addr, ethers.MaxUint256);
    }

    return { gacha, pay, admin, treasury, user, relayer, other };
  }

  it("commit escrows the fee in the contract (not yet to treasury)", async function () {
    const { gacha, pay, treasury, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));

    const tBefore = await pay.balanceOf(treasury.address);
    await gacha.connect(user)[COMMIT1](saltHash(salt));

    expect(await pay.balanceOf(treasury.address)).to.equal(tBefore); // not forwarded yet
    expect(await pay.balanceOf(await gacha.getAddress())).to.equal(PRICE); // escrowed
    const c = await gacha.commitments(user.address);
    expect(c.commitBlock).to.be.gt(0n);
    expect(c.escrow).to.equal(PRICE);
  });

  it("rejects a zero salt hash", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    await expect(
      gacha.connect(user)[COMMIT1](ethers.ZeroHash)
    ).to.be.revertedWithCustomError(gacha, "ZeroSaltHash");
  });

  it("happy path: reveal mints with a valid rarity and forwards the fee", async function () {
    const { gacha, pay, treasury, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));

    await gacha.connect(user)[COMMIT1](saltHash(salt));
    await mine(2); // advance past commitBlock+1

    const tBefore = await pay.balanceOf(treasury.address);
    await gacha.connect(user).reveal(salt);

    expect(await gacha.balanceOf(user.address)).to.equal(1n);
    expect(await gacha.ownerOf(0)).to.equal(user.address);

    const rarity = await gacha.rarityOf(0);
    expect(rarity).to.be.gte(0n);
    expect(rarity).to.be.lt(BigInt(NAMES.length));

    // fee forwarded to treasury on reveal; escrow drained
    expect(await pay.balanceOf(treasury.address)).to.equal(tBefore + PRICE);
    expect(await pay.balanceOf(await gacha.getAddress())).to.equal(0n);

    // commit cleared
    expect((await gacha.commitments(user.address)).commitBlock).to.equal(0n);
  });

  it("too-early reveal reverts (TooEarly)", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await gacha.connect(user)[COMMIT1](saltHash(salt));
    // blockhash(commitBlock+1) not available yet
    await expect(gacha.connect(user).reveal(salt)).to.be.revertedWithCustomError(
      gacha,
      "TooEarly"
    );
  });

  it("wrong salt reverts (BadSalt)", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const wrong = ethers.hexlify(ethers.randomBytes(32));

    await gacha.connect(user)[COMMIT1](saltHash(salt));
    await mine(2);

    await expect(gacha.connect(user).reveal(wrong)).to.be.revertedWithCustomError(
      gacha,
      "BadSalt"
    );
  });

  it("expired reveal reverts (TooLate) and refundExpired returns the escrow", async function () {
    const { gacha, pay, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));

    await gacha.connect(user)[COMMIT1](saltHash(salt));
    // push blockhash(commitBlock+1) out of the 256-block lookback window
    await mine(300);

    expect(await gacha.isExpired(user.address)).to.equal(true);
    await expect(gacha.connect(user).reveal(salt)).to.be.revertedWithCustomError(
      gacha,
      "TooLate"
    );

    const before = await pay.balanceOf(user.address);
    await expect(gacha.connect(user).refundExpired())
      .to.emit(gacha, "Refunded")
      .withArgs(user.address, PRICE);
    expect((await pay.balanceOf(user.address)) - before).to.equal(PRICE);

    // commit cleared; a fresh commit is possible again
    expect((await gacha.commitments(user.address)).commitBlock).to.equal(0n);
    await gacha.connect(user)[COMMIT1](saltHash(salt));
  });

  it("refundExpired before expiry reverts (NotExpired)", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await gacha.connect(user)[COMMIT1](saltHash(salt));
    await mine(2);
    await expect(
      gacha.connect(user).refundExpired()
    ).to.be.revertedWithCustomError(gacha, "NotExpired");
  });

  it("double-reveal reverts (commit cleared after first reveal)", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await gacha.connect(user)[COMMIT1](saltHash(salt));
    await mine(2);
    await gacha.connect(user).reveal(salt);

    await expect(gacha.connect(user).reveal(salt)).to.be.revertedWithCustomError(
      gacha,
      "NoCommit"
    );
  });

  it("cannot open a second commit while one is open", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await gacha.connect(user)[COMMIT1](saltHash(salt));
    await expect(
      gacha.connect(user)[COMMIT1](saltHash(salt))
    ).to.be.revertedWithCustomError(gacha, "CommitOpen");
  });

  it("relayer overload lets a payer fund a caller's commit", async function () {
    const { gacha, pay, treasury, user, relayer } = await loadFixture(deployFixture);
    const salt = ethers.hexlify(ethers.randomBytes(32));

    const relBefore = await pay.balanceOf(relayer.address);
    await gacha.connect(user)["commit(bytes32,address)"](saltHash(salt), relayer.address);
    // relayer was charged, escrow lives in the contract
    expect(relBefore - (await pay.balanceOf(relayer.address))).to.equal(PRICE);
    expect(await pay.balanceOf(await gacha.getAddress())).to.equal(PRICE);

    await mine(2);
    const tBefore = await pay.balanceOf(treasury.address);
    await gacha.connect(user).reveal(salt); // commit belongs to user
    expect(await gacha.ownerOf(0)).to.equal(user.address);
    expect((await pay.balanceOf(treasury.address)) - tBefore).to.equal(PRICE);
  });

  it("odds views disclose the configured table", async function () {
    const { gacha } = await loadFixture(deployFixture);
    expect(await gacha.rarityWeights()).to.deep.equal(WEIGHTS);
    expect(await gacha.rarityNames()).to.deep.equal(NAMES);
    expect(await gacha.totalWeight()).to.equal(100n);
    expect(await gacha.rarityCount()).to.equal(BigInt(NAMES.length));
    expect(await gacha.rarityName(2)).to.equal("Legendary");
    expect(await gacha.rarityWeight(0)).to.equal(70n);
  });

  it("distribution sanity: many seeded pulls land in-range and hit multiple tiers", async function () {
    const { gacha, user } = await loadFixture(deployFixture);
    const counts = [0, 0, 0];
    const N = 40;

    for (let i = 0; i < N; i++) {
      const salt = ethers.zeroPadValue(ethers.toBeHex(i + 1), 32);
      await gacha.connect(user)[COMMIT1](saltHash(salt));
      await mine(2);
      await gacha.connect(user).reveal(salt);
      const r = Number(await gacha.rarityOf(i));
      expect(r).to.be.within(0, NAMES.length - 1);
      counts[r] += 1;
    }

    // Common (weight 70) should dominate; at least two distinct tiers should appear.
    const distinct = counts.filter((c) => c > 0).length;
    expect(distinct).to.be.gte(2);
    expect(counts[0]).to.be.gt(0);
    expect(counts.reduce((a, b) => a + b, 0)).to.equal(N);
  });
});
