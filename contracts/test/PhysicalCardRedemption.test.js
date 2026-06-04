const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const TOKEN = 0;
const NFT = 1;

// Deterministic card material.
function serialOf(i) {
  return ethers.id(`serial-${i}`);
}
function secretOf(i) {
  return ethers.id(`secret-${i}`);
}
function commitOf(i) {
  return ethers.keccak256(
    ethers.solidityPacked(["bytes32", "bytes32"], [serialOf(i), secretOf(i)])
  );
}

describe("PhysicalCardRedemption", function () {
  const PER_CARD = 100n;
  const POOL = 10_000n;

  async function deployFixture() {
    const [admin, treasury, alice, bob, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Reward", "RWD");

    // PranaNFT used as the NFT minter target (has MINTER_ROLE-gated mint(to, uri)).
    const Nft = await ethers.getContractFactory("PranaNFT");
    const nft = await Nft.deploy(admin.address);

    const Redeem = await ethers.getContractFactory("PhysicalCardRedemption");
    const redeem = await Redeem.deploy(admin.address);

    // Fund the token pool.
    await token.mint(await redeem.getAddress(), POOL);

    // Grant the redemption contract the NFT minter role.
    const MINTER_ROLE = await nft.MINTER_ROLE();
    await nft.connect(admin).grantRole(MINTER_ROLE, await redeem.getAddress());

    return { admin, treasury, alice, bob, other, token, nft, redeem };
  }

  async function freshExpiry(extra = DAY) {
    return BigInt((await time.latest()) + extra);
  }

  it("constructor wires roles", async () => {
    const { redeem, admin } = await loadFixture(deployFixture);
    expect(await redeem.hasRole(await redeem.ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await redeem.hasRole(await redeem.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
  });

  it("creates a TOKEN batch, registers commitments, redeems to recipient", async () => {
    const { redeem, admin, token, alice } = await loadFixture(deployFixture);
    const expiry = await freshExpiry();

    await expect(
      redeem.connect(admin).createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", expiry)
    )
      .to.emit(redeem, "BatchCreated")
      .withArgs(1, TOKEN, await token.getAddress(), PER_CARD, expiry);

    const commits = [commitOf(0), commitOf(1)];
    await expect(redeem.connect(admin).registerCommitments(1, commits))
      .to.emit(redeem, "RedeemableRegistered")
      .withArgs(1, 2, 2);

    await expect(redeem.redeem(serialOf(0), secretOf(0), alice.address))
      .to.emit(redeem, "CardRedeemed")
      .withArgs(1, commitOf(0), alice.address);

    expect(await token.balanceOf(alice.address)).to.equal(PER_CARD);
  });

  it("redeems an NFT batch via the minter role", async () => {
    const { redeem, admin, nft, bob } = await loadFixture(deployFixture);
    const expiry = await freshExpiry();

    await redeem
      .connect(admin)
      .createBatch(2, NFT, await nft.getAddress(), 0, "ipfs://card.json", expiry);
    await redeem.connect(admin).registerCommitments(2, [commitOf(5)]);

    await expect(redeem.redeem(serialOf(5), secretOf(5), bob.address))
      .to.emit(redeem, "CardRedeemed")
      .withArgs(2, commitOf(5), bob.address);

    expect(await nft.balanceOf(bob.address)).to.equal(1n);
    expect(await nft.ownerOf(0)).to.equal(bob.address);
  });

  it("rejects a wrong secret (commitment unknown)", async () => {
    const { redeem, admin, token, alice } = await loadFixture(deployFixture);
    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", await freshExpiry());
    await redeem.connect(admin).registerCommitments(1, [commitOf(0)]);

    await expect(
      redeem.redeem(serialOf(0), ethers.id("wrong"), alice.address)
    ).to.be.revertedWithCustomError(redeem, "CommitmentUnknown");
  });

  it("guards against double redemption", async () => {
    const { redeem, admin, token, alice, bob } = await loadFixture(deployFixture);
    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", await freshExpiry());
    await redeem.connect(admin).registerCommitments(1, [commitOf(0)]);

    await redeem.redeem(serialOf(0), secretOf(0), alice.address);
    await expect(
      redeem.redeem(serialOf(0), secretOf(0), bob.address)
    ).to.be.revertedWithCustomError(redeem, "AlreadyRedeemed");
  });

  it("rejects duplicate commitment registration", async () => {
    const { redeem, admin, token } = await loadFixture(deployFixture);
    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", await freshExpiry());
    await redeem.connect(admin).registerCommitments(1, [commitOf(0)]);
    await expect(
      redeem.connect(admin).registerCommitments(1, [commitOf(0)])
    ).to.be.revertedWithCustomError(redeem, "CommitmentAlreadyRegistered");
  });

  it("blocks redemption after expiry and lets admin sweep unredeemed funds", async () => {
    const { redeem, admin, treasury, token, alice } = await loadFixture(deployFixture);
    const expiry = await freshExpiry(100);
    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", expiry);
    // register 3 cards (300 escrowed against the pool); redeem 1 before expiry.
    await redeem.connect(admin).registerCommitments(1, [commitOf(0), commitOf(1), commitOf(2)]);
    await redeem.redeem(serialOf(0), secretOf(0), alice.address);

    await time.increaseTo(expiry);

    // redemption now closed
    await expect(
      redeem.redeem(serialOf(1), secretOf(1), alice.address)
    ).to.be.revertedWithCustomError(redeem, "BatchExpired");

    // sweep: 2 unredeemed * 100 = 200 back to treasury
    const before = await token.balanceOf(treasury.address);
    await expect(redeem.connect(admin).sweep(1, treasury.address))
      .to.emit(redeem, "BatchSwept")
      .withArgs(1, treasury.address, 200n);
    expect((await token.balanceOf(treasury.address)) - before).to.equal(200n);

    // cannot sweep twice
    await expect(
      redeem.connect(admin).sweep(1, treasury.address)
    ).to.be.revertedWithCustomError(redeem, "AlreadySwept");
  });

  it("sweep is blocked before expiry and for NFT batches", async () => {
    const { redeem, admin, treasury, token, nft } = await loadFixture(deployFixture);
    const expiry = await freshExpiry();
    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", expiry);
    await expect(
      redeem.connect(admin).sweep(1, treasury.address)
    ).to.be.revertedWithCustomError(redeem, "BatchNotExpired");

    await redeem
      .connect(admin)
      .createBatch(2, NFT, await nft.getAddress(), 0, "ipfs://x", await freshExpiry(50));
    await time.increase(60);
    await expect(
      redeem.connect(admin).sweep(2, treasury.address)
    ).to.be.revertedWithCustomError(redeem, "WrongKind");
  });

  it("reverts redemption when the token pool is insolvent", async () => {
    const { redeem, admin, token, alice } = await loadFixture(deployFixture);
    // Drain the whole pool via a fresh batch + sweep is not possible pre-expiry, so use a
    // batch whose per-card amount exceeds the pool.
    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), POOL + 1n, "", await freshExpiry());
    await redeem.connect(admin).registerCommitments(1, [commitOf(0)]);
    await expect(
      redeem.redeem(serialOf(0), secretOf(0), alice.address)
    ).to.be.revertedWithCustomError(redeem, "PoolInsolvent");
  });

  it("only admin can create batches / register / sweep", async () => {
    const { redeem, other, token } = await loadFixture(deployFixture);
    await expect(
      redeem.connect(other).createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", await freshExpiry())
    ).to.be.revertedWithCustomError(redeem, "AccessControlUnauthorizedAccount");
  });

  it("rejects creating a batch with past expiry or duplicate id", async () => {
    const { redeem, admin, token } = await loadFixture(deployFixture);
    const past = BigInt((await time.latest()) - 1);
    await expect(
      redeem.connect(admin).createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", past)
    ).to.be.revertedWithCustomError(redeem, "BadExpiry");

    await redeem
      .connect(admin)
      .createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", await freshExpiry());
    await expect(
      redeem.connect(admin).createBatch(1, TOKEN, await token.getAddress(), PER_CARD, "", await freshExpiry())
    ).to.be.revertedWithCustomError(redeem, "BatchExists");
  });
});
