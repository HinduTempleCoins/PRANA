const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

describe("ArcadeFaucet", function () {
  const COOLDOWN = 3600; // 1 hour
  const PER_PLAYER_CAP = 1000n;
  const GLOBAL_CAP = 5000n;
  const FUND = 1_000_000n;

  async function deployFixture() {
    const [admin, attester, player, other, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Reward", "RWD");

    const Faucet = await ethers.getContractFactory("ArcadeFaucet");
    const faucet = await Faucet.deploy(
      admin.address,
      attester.address,
      await token.getAddress(),
      COOLDOWN,
      PER_PLAYER_CAP,
      GLOBAL_CAP
    );

    // Pre-fund the faucet from its own balance (it is NOT a minter).
    await token.mint(await faucet.getAddress(), FUND);

    return { admin, attester, player, other, treasury, token, faucet };
  }

  // EIP-712 voucher signer matching ArcadeFaucet's domain + types.
  async function signVoucher(faucet, signer, v) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "ArcadeFaucet",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await faucet.getAddress(),
    };
    const types = {
      Voucher: [
        { name: "player", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "scoreRef", type: "bytes32" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, v);
  }

  async function makeVoucher(overrides = {}) {
    const now = await time.latest();
    return {
      player: overrides.player,
      amount: overrides.amount ?? 100n,
      scoreRef: overrides.scoreRef ?? ethers.id("score-1"),
      deadline: overrides.deadline ?? BigInt(now + DAY),
      nonce: overrides.nonce ?? 1n,
    };
  }

  it("constructor sets roles and config", async () => {
    const { faucet, admin, attester } = await loadFixture(deployFixture);
    expect(await faucet.hasRole(await faucet.ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await faucet.hasRole(await faucet.ATTESTER_ROLE(), attester.address)).to.equal(true);
    expect(await faucet.cooldown()).to.equal(COOLDOWN);
    expect(await faucet.perPlayerDailyCap()).to.equal(PER_PLAYER_CAP);
    expect(await faucet.globalDailyCap()).to.equal(GLOBAL_CAP);
  });

  it("pays out on a valid voucher (happy path)", async () => {
    const { faucet, attester, player, token } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address, amount: 250n });
    const sig = await signVoucher(faucet, attester, v);

    await expect(faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig))
      .to.emit(faucet, "Claimed")
      .withArgs(v.player, v.amount, v.scoreRef, v.nonce, await faucet.currentDay());

    expect(await token.balanceOf(player.address)).to.equal(250n);
    expect(await faucet.usedNonce(v.nonce)).to.equal(true);
  });

  it("anyone can submit the tx; funds go to the bound player", async () => {
    const { faucet, attester, player, other, token } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address, amount: 100n });
    const sig = await signVoucher(faucet, attester, v);
    await faucet.connect(other).claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig);
    expect(await token.balanceOf(player.address)).to.equal(100n);
    expect(await token.balanceOf(other.address)).to.equal(0n);
  });

  it("reverts an expired voucher", async () => {
    const { faucet, attester, player } = await loadFixture(deployFixture);
    const now = await time.latest();
    const v = await makeVoucher({ player: player.address, deadline: BigInt(now + 10) });
    const sig = await signVoucher(faucet, attester, v);

    await time.increase(20);
    await expect(faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig))
      .to.be.revertedWithCustomError(faucet, "VoucherExpired")
      .withArgs(v.deadline);
  });

  it("reverts a replayed voucher (single-use nonce)", async () => {
    const { faucet, attester, player } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address, amount: 100n, nonce: 42n });
    const sig = await signVoucher(faucet, attester, v);

    await faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig);
    await expect(faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig))
      .to.be.revertedWithCustomError(faucet, "NonceAlreadyUsed")
      .withArgs(42n);
  });

  it("reverts a voucher signed by a non-attester", async () => {
    const { faucet, other, player } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address });
    const sig = await signVoucher(faucet, other, v); // wrong signer
    await expect(faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig))
      .to.be.revertedWithCustomError(faucet, "BadSigner")
      .withArgs(other.address);
  });

  it("reverts when fields are tampered after signing", async () => {
    const { faucet, attester, player } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address, amount: 100n });
    const sig = await signVoucher(faucet, attester, v);
    // recovered signer won't match attester -> BadSigner
    await expect(faucet.claim(v.player, 200n, v.scoreRef, v.deadline, v.nonce, sig))
      .to.be.revertedWithCustomError(faucet, "BadSigner");
  });

  it("enforces per-player cooldown between claims", async () => {
    const { faucet, attester, player } = await loadFixture(deployFixture);
    const v1 = await makeVoucher({ player: player.address, amount: 100n, nonce: 1n });
    await faucet.claim(v1.player, v1.amount, v1.scoreRef, v1.deadline, v1.nonce,
      await signVoucher(faucet, attester, v1));

    const v2 = await makeVoucher({ player: player.address, amount: 100n, nonce: 2n });
    const sig2 = await signVoucher(faucet, attester, v2);
    await expect(faucet.claim(v2.player, v2.amount, v2.scoreRef, v2.deadline, v2.nonce, sig2))
      .to.be.revertedWithCustomError(faucet, "CooldownActive");

    // after cooldown elapses, the second claim succeeds
    await time.increase(COOLDOWN);
    await expect(faucet.claim(v2.player, v2.amount, v2.scoreRef, v2.deadline, v2.nonce, sig2))
      .to.emit(faucet, "Claimed");
  });

  it("enforces the per-player daily cap, which rolls over at the day boundary", async () => {
    const { faucet, attester, player } = await loadFixture(deployFixture);
    // cap is 1000/day; do 1000 across the day (cooldown 1h apart), then 1 more must fail.
    // claim 1000 in one voucher (within per-player cap exactly).
    const v1 = await makeVoucher({ player: player.address, amount: PER_PLAYER_CAP, nonce: 1n });
    await faucet.claim(v1.player, v1.amount, v1.scoreRef, v1.deadline, v1.nonce,
      await signVoucher(faucet, attester, v1));

    await time.increase(COOLDOWN);
    const v2 = await makeVoucher({ player: player.address, amount: 1n, nonce: 2n });
    const sig2 = await signVoucher(faucet, attester, v2);
    await expect(faucet.claim(v2.player, v2.amount, v2.scoreRef, v2.deadline, v2.nonce, sig2))
      .to.be.revertedWithCustomError(faucet, "PerPlayerCapExceeded");

    // cross into the next day -> per-player budget resets.
    await time.increase(DAY);
    const v3 = await makeVoucher({ player: player.address, amount: 1n, nonce: 3n });
    await expect(faucet.claim(v3.player, v3.amount, v3.scoreRef, v3.deadline, v3.nonce,
      await signVoucher(faucet, attester, v3))).to.emit(faucet, "Claimed");
  });

  it("enforces the global daily cap across players, rolling over at the day boundary", async () => {
    const { faucet, admin, attester } = await loadFixture(deployFixture);
    // Tighten the global cap to make it the binding constraint, raise per-player cap.
    await faucet.connect(admin).setGlobalDailyCap(150n);
    await faucet.connect(admin).setPerPlayerDailyCap(1000n);
    await faucet.connect(admin).setCooldown(0);

    const signers = await ethers.getSigners();
    const p1 = signers[5];
    const p2 = signers[6];

    const va = await makeVoucher({ player: p1.address, amount: 100n, nonce: 10n });
    await faucet.claim(va.player, va.amount, va.scoreRef, va.deadline, va.nonce,
      await signVoucher(faucet, attester, va));

    // 100 + 100 = 200 > 150 global -> second player blocked
    // (deadline must outlive the +1 day jump below, so give it 3 days)
    const vb = await makeVoucher({
      player: p2.address,
      amount: 100n,
      nonce: 11n,
      deadline: BigInt((await time.latest()) + 3 * DAY),
    });
    const sigb = await signVoucher(faucet, attester, vb);
    await expect(faucet.claim(vb.player, vb.amount, vb.scoreRef, vb.deadline, vb.nonce, sigb))
      .to.be.revertedWithCustomError(faucet, "GlobalCapExceeded");

    // next day -> global budget resets, same voucher now clears
    await time.increase(DAY);
    await expect(faucet.claim(vb.player, vb.amount, vb.scoreRef, vb.deadline, vb.nonce, sigb))
      .to.emit(faucet, "Claimed");
  });

  it("reverts cleanly when the faucet is insolvent", async () => {
    const { faucet, admin, attester, player, token } = await loadFixture(deployFixture);
    // Drain the faucet via admin rescue so it cannot cover the payout.
    const bal = await token.balanceOf(await faucet.getAddress());
    await faucet.connect(admin).rescue(admin.address, bal);

    const v = await makeVoucher({ player: player.address, amount: 100n });
    const sig = await signVoucher(faucet, attester, v);
    await expect(faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce, sig))
      .to.be.revertedWithCustomError(faucet, "FaucetInsolvent")
      .withArgs(100n, 0n);
  });

  it("rotates the attester role: old key stops working, new key works", async () => {
    const { faucet, admin, attester, other, player } = await loadFixture(deployFixture);
    const ATTESTER_ROLE = await faucet.ATTESTER_ROLE();

    // grant new attester, revoke old
    await faucet.connect(admin).grantRole(ATTESTER_ROLE, other.address);
    await faucet.connect(admin).revokeRole(ATTESTER_ROLE, attester.address);

    const vOld = await makeVoucher({ player: player.address, nonce: 1n });
    await expect(faucet.claim(vOld.player, vOld.amount, vOld.scoreRef, vOld.deadline, vOld.nonce,
      await signVoucher(faucet, attester, vOld)))
      .to.be.revertedWithCustomError(faucet, "BadSigner");

    const vNew = await makeVoucher({ player: player.address, nonce: 2n });
    await expect(faucet.claim(vNew.player, vNew.amount, vNew.scoreRef, vNew.deadline, vNew.nonce,
      await signVoucher(faucet, other, vNew))).to.emit(faucet, "Claimed");
  });

  it("only ADMIN_ROLE can change config", async () => {
    const { faucet, other } = await loadFixture(deployFixture);
    await expect(faucet.connect(other).setCooldown(0))
      .to.be.revertedWithCustomError(faucet, "AccessControlUnauthorizedAccount");
    await expect(faucet.connect(other).setGlobalDailyCap(1n))
      .to.be.revertedWithCustomError(faucet, "AccessControlUnauthorizedAccount");
  });

  it("exposes remaining player and global budgets", async () => {
    const { faucet, attester, player } = await loadFixture(deployFixture);
    expect(await faucet.remainingPlayerBudget(player.address)).to.equal(PER_PLAYER_CAP);
    expect(await faucet.remainingGlobalBudget()).to.equal(GLOBAL_CAP);

    const v = await makeVoucher({ player: player.address, amount: 200n });
    await faucet.claim(v.player, v.amount, v.scoreRef, v.deadline, v.nonce,
      await signVoucher(faucet, attester, v));

    expect(await faucet.remainingPlayerBudget(player.address)).to.equal(PER_PLAYER_CAP - 200n);
    expect(await faucet.remainingGlobalBudget()).to.equal(GLOBAL_CAP - 200n);
  });
});
