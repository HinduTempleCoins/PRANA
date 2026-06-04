const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

describe("GeominingSettlement", function () {
  const COOLDOWN = 3600;
  const CELL_EPOCH_CAP = 1000n;
  const MIN_STAKE = 1000n;
  const POOL = 1_000_000n;

  async function deployFixture() {
    const [admin, attestor, player, other, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Reward", "RWD");
    const stakeToken = await Mock.deploy("Stake", "STK");

    const Stake = await ethers.getContractFactory("AttestationStakeSlash");
    const stake = await Stake.deploy(
      await stakeToken.getAddress(),
      MIN_STAKE,
      treasury.address,
      admin.address
    );

    const Settle = await ethers.getContractFactory("GeominingSettlement");
    const settle = await Settle.deploy(
      admin.address,
      attestor.address,
      await token.getAddress(),
      await stake.getAddress(),
      COOLDOWN,
      CELL_EPOCH_CAP
    );

    await token.mint(await settle.getAddress(), POOL);

    // Make the attestor active in the stake registry.
    await stakeToken.mint(attestor.address, 10_000n);
    await stakeToken.connect(attestor).approve(await stake.getAddress(), 10_000n);
    await stake.connect(attestor).stake(MIN_STAKE);

    return { admin, attestor, player, other, treasury, token, stakeToken, stake, settle };
  }

  async function signVoucher(settle, signer, v) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "GeominingSettlement",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await settle.getAddress(),
    };
    const types = {
      GeoVoucher: [
        { name: "player", type: "address" },
        { name: "cellId", type: "uint256" },
        { name: "epoch", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, v);
  }

  async function makeVoucher(o = {}) {
    const now = await time.latest();
    return {
      player: o.player,
      cellId: o.cellId ?? 42n,
      epoch: o.epoch ?? 1n,
      amount: o.amount ?? 100n,
      nonce: o.nonce ?? 1n,
      deadline: o.deadline ?? BigInt(now + DAY),
    };
  }

  function args(v, sig) {
    return [v.player, v.cellId, v.epoch, v.amount, v.nonce, v.deadline, sig];
  }

  it("constructor wires roles and config", async () => {
    const { settle, admin, attestor } = await loadFixture(deployFixture);
    expect(await settle.hasRole(await settle.ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await settle.hasRole(await settle.ATTESTOR_ROLE(), attestor.address)).to.equal(true);
    expect(await settle.cellCooldown()).to.equal(COOLDOWN);
    expect(await settle.cellEpochCap()).to.equal(CELL_EPOCH_CAP);
  });

  it("settles a valid voucher from an active attestor", async () => {
    const { settle, attestor, player, token } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address, amount: 250n });
    const sig = await signVoucher(settle, attestor, v);

    await expect(settle.claim(...args(v, sig)))
      .to.emit(settle, "Claimed")
      .withArgs(player.address, v.cellId, v.epoch, v.amount, v.nonce);

    expect(await token.balanceOf(player.address)).to.equal(250n);
  });

  it("reverts a voucher signed by a non-attestor", async () => {
    const { settle, other, player } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address });
    const sig = await signVoucher(settle, other, v);
    await expect(settle.claim(...args(v, sig)))
      .to.be.revertedWithCustomError(settle, "BadSigner")
      .withArgs(other.address);
  });

  it("reverts if the attestor is not active in the stake registry", async () => {
    const { settle, stake, attestor, player } = await loadFixture(deployFixture);
    // Unstake below minStake -> inactive.
    await stake.connect(attestor).unstake(MIN_STAKE);
    const v = await makeVoucher({ player: player.address });
    const sig = await signVoucher(settle, attestor, v);
    await expect(settle.claim(...args(v, sig)))
      .to.be.revertedWithCustomError(settle, "AttestorInactive")
      .withArgs(attestor.address);
  });

  it("works without a stake registry wired (zero address)", async () => {
    const { admin, attestor, player, token } = await loadFixture(deployFixture);
    const Settle = await ethers.getContractFactory("GeominingSettlement");
    const settle = await Settle.deploy(
      admin.address,
      attestor.address,
      await token.getAddress(),
      ethers.ZeroAddress,
      COOLDOWN,
      CELL_EPOCH_CAP
    );
    await token.mint(await settle.getAddress(), POOL);
    const v = await makeVoucher({ player: player.address });
    const sig = await signVoucher(settle, attestor, v);
    await expect(settle.claim(...args(v, sig))).to.emit(settle, "Claimed");
  });

  it("reverts a replayed voucher (single-use nonce)", async () => {
    const { settle, attestor, player } = await loadFixture(deployFixture);
    const v = await makeVoucher({ player: player.address, nonce: 7n });
    const sig = await signVoucher(settle, attestor, v);
    await settle.claim(...args(v, sig));
    await expect(settle.claim(...args(v, sig)))
      .to.be.revertedWithCustomError(settle, "NonceAlreadyUsed")
      .withArgs(7n);
  });

  it("reverts an expired voucher", async () => {
    const { settle, attestor, player } = await loadFixture(deployFixture);
    const now = await time.latest();
    const v = await makeVoucher({ player: player.address, deadline: BigInt(now + 10) });
    const sig = await signVoucher(settle, attestor, v);
    await time.increase(20);
    await expect(settle.claim(...args(v, sig)))
      .to.be.revertedWithCustomError(settle, "VoucherExpired")
      .withArgs(v.deadline);
  });

  it("enforces per-cell cooldown", async () => {
    const { settle, attestor, player } = await loadFixture(deployFixture);
    const v1 = await makeVoucher({ player: player.address, cellId: 9n, nonce: 1n });
    await settle.claim(...args(v1, await signVoucher(settle, attestor, v1)));

    const v2 = await makeVoucher({ player: player.address, cellId: 9n, nonce: 2n });
    const sig2 = await signVoucher(settle, attestor, v2);
    await expect(settle.claim(...args(v2, sig2))).to.be.revertedWithCustomError(
      settle,
      "CellCooldownActive"
    );

    // a DIFFERENT cell is not on cooldown
    const v3 = await makeVoucher({ player: player.address, cellId: 10n, nonce: 3n });
    await expect(settle.claim(...args(v3, await signVoucher(settle, attestor, v3)))).to.emit(
      settle,
      "Claimed"
    );

    // after cooldown elapses, cell 9 clears
    await time.increase(COOLDOWN);
    await expect(settle.claim(...args(v2, sig2))).to.emit(settle, "Claimed");
  });

  it("enforces per-cell per-epoch cap, resetting across epochs", async () => {
    const { settle, admin, attestor, player } = await loadFixture(deployFixture);
    await settle.connect(admin).setCellCooldown(0); // isolate the cap

    const v1 = await makeVoucher({
      player: player.address,
      cellId: 5n,
      epoch: 1n,
      amount: CELL_EPOCH_CAP,
      nonce: 1n,
    });
    await settle.claim(...args(v1, await signVoucher(settle, attestor, v1)));

    const v2 = await makeVoucher({
      player: player.address,
      cellId: 5n,
      epoch: 1n,
      amount: 1n,
      nonce: 2n,
    });
    await expect(
      settle.claim(...args(v2, await signVoucher(settle, attestor, v2)))
    ).to.be.revertedWithCustomError(settle, "CellEpochCapExceeded");

    // same cell, NEXT epoch -> fresh budget
    const v3 = await makeVoucher({
      player: player.address,
      cellId: 5n,
      epoch: 2n,
      amount: 1n,
      nonce: 3n,
    });
    await expect(
      settle.claim(...args(v3, await signVoucher(settle, attestor, v3)))
    ).to.emit(settle, "Claimed");
  });

  it("reverts cleanly when the pool is insolvent", async () => {
    const { settle, admin, attestor, player, token } = await loadFixture(deployFixture);
    const bal = await token.balanceOf(await settle.getAddress());
    await settle.connect(admin).rescue(admin.address, bal);
    const v = await makeVoucher({ player: player.address, amount: 100n });
    await expect(settle.claim(...args(v, await signVoucher(settle, attestor, v))))
      .to.be.revertedWithCustomError(settle, "PoolInsolvent")
      .withArgs(100n, 0n);
  });

  it("only admin can change config", async () => {
    const { settle, other } = await loadFixture(deployFixture);
    await expect(settle.connect(other).setCellCooldown(0)).to.be.revertedWithCustomError(
      settle,
      "AccessControlUnauthorizedAccount"
    );
  });
});
