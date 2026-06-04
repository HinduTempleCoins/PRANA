const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BOOST_ONE = 10n ** 18n;
const ZERO = ethers.ZeroAddress;

describe("EnergyStamina", function () {
  const MAX = 1000n;
  const REGEN = 10n; // per block

  async function deployFixture() {
    // game / game2 are EOAs standing in for game contracts: they are registered AND call spend().
    const [admin, game, game2, player, other] = await ethers.getSigners();

    const Stamina = await ethers.getContractFactory("EnergyStamina");
    const stamina = await Stamina.deploy(admin.address);

    // admin holds GAME_ROLE (granted in constructor) so can register games.
    await stamina.connect(admin).registerGame(game.address, MAX, REGEN);

    // a staked-balance source for the boost-path test.
    const Mock = await ethers.getContractFactory("MockERC20");
    const stakeToken = await Mock.deploy("Stake", "STK");

    return { admin, game, game2, player, other, stamina, stakeToken };
  }

  it("constructor grants roles and game registration works", async () => {
    const { stamina, admin, game } = await loadFixture(deployFixture);
    expect(await stamina.hasRole(await stamina.ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await stamina.hasRole(await stamina.GAME_ROLE(), admin.address)).to.equal(true);
    const g = await stamina.games(game.address);
    expect(g.registered).to.equal(true);
    expect(g.maxEnergy).to.equal(MAX);
    expect(g.regenPerBlock).to.equal(REGEN);
  });

  it("a fresh player starts at the full cap", async () => {
    const { stamina, game, player } = await loadFixture(deployFixture);
    expect(await stamina.energyOf(game.address, player.address)).to.equal(MAX);
  });

  it("spends energy and regenerates lazily per block, capped at max", async () => {
    const { stamina, game, player } = await loadFixture(deployFixture);

    // spend 600 -> 400 left (spend tx mines a block and settles the meter)
    await stamina.connect(game).spend(player.address, 600n);
    expect(await stamina.energyOf(game.address, player.address)).to.equal(400n);

    // mine 10 blocks -> +100 regen -> 500
    await mine(10);
    expect(await stamina.energyOf(game.address, player.address)).to.equal(500n);

    // mine far past the cap -> clamps at MAX
    await mine(1000);
    expect(await stamina.energyOf(game.address, player.address)).to.equal(MAX);
  });

  it("regen math is exact at the boundary", async () => {
    const { stamina, game, player } = await loadFixture(deployFixture);
    await stamina.connect(game).spend(player.address, 1000n); // drained to 0
    expect(await stamina.energyOf(game.address, player.address)).to.equal(0n);

    await mine(50); // +500
    expect(await stamina.energyOf(game.address, player.address)).to.equal(500n);

    await mine(50); // +500 -> exactly MAX
    expect(await stamina.energyOf(game.address, player.address)).to.equal(MAX);
  });

  it("reverts spending more than the available budget", async () => {
    const { stamina, game, player } = await loadFixture(deployFixture);
    await stamina.connect(game).spend(player.address, 1000n); // now 0
    // The next spend tx itself mines a block, regenerating regenPerBlock (10) energy —
    // so ask for far more than one block can regenerate.
    await expect(stamina.connect(game).spend(player.address, 1000n))
      .to.be.revertedWithCustomError(stamina, "InsufficientEnergy");
  });

  it("reverts spend from an unregistered game", async () => {
    const { stamina, other, player } = await loadFixture(deployFixture);
    await expect(stamina.connect(other).spend(player.address, 1n))
      .to.be.revertedWithCustomError(stamina, "NotRegistered")
      .withArgs(other.address);
  });

  it("isolates meters across games (multi-game)", async () => {
    const { stamina, admin, game, game2, player } = await loadFixture(deployFixture);
    // register a second game with a different cap
    await stamina.connect(admin).registerGame(game2.address, 500n, 5n);

    // drain game1 fully
    await stamina.connect(game).spend(player.address, 1000n);
    expect(await stamina.energyOf(game.address, player.address)).to.equal(0n);

    // game2 meter is untouched -> still full at its own cap
    expect(await stamina.energyOf(game2.address, player.address)).to.equal(500n);

    // spending in game2 does not affect game1
    await stamina.connect(game2).spend(player.address, 200n);
    expect(await stamina.energyOf(game2.address, player.address)).to.equal(300n);
    expect(await stamina.energyOf(game.address, player.address)).to.be.lessThanOrEqual(MAX);

    // game2 cannot be spent by game1's address budget semantics: each call uses msg.sender's meter
    // game1 (now regenerating) and game2 (300) are independent
  });

  it("stake-boost multiplier raises cap and regen via the external source", async () => {
    const { stamina, admin, game, player, stakeToken } = await loadFixture(deployFixture);

    // boost: +1e-? per staked unit. Use boostPerStake so 100 staked -> +1.0x (=> 2.0x), cap 3x.
    // multiplier = BOOST_ONE + staked * boostPerStake. Want 100 staked => +1.0 => boostPerStake = BOOST_ONE/100.
    const boostPerStake = BOOST_ONE / 100n;
    const maxBoost = 3n * BOOST_ONE;
    await stamina.connect(admin).setStakeBoost(
      game.address, await stakeToken.getAddress(), boostPerStake, maxBoost
    );

    // no stake yet -> 1x
    expect(await stamina.boostOf(game.address, player.address)).to.equal(BOOST_ONE);
    expect(await stamina.maxEnergyOf(game.address, player.address)).to.equal(MAX);

    // stake 100 -> 2x
    await stakeToken.mint(player.address, 100n);
    expect(await stamina.boostOf(game.address, player.address)).to.equal(2n * BOOST_ONE);
    expect(await stamina.maxEnergyOf(game.address, player.address)).to.equal(2n * MAX);
    expect(await stamina.regenPerBlockOf(game.address, player.address)).to.equal(2n * REGEN);
    // fresh player now starts at the boosted cap
    expect(await stamina.energyOf(game.address, player.address)).to.equal(2n * MAX);

    // stake a huge amount -> clamps at maxBoost (3x)
    await stakeToken.mint(player.address, 1_000_000n);
    expect(await stamina.boostOf(game.address, player.address)).to.equal(maxBoost);
    expect(await stamina.maxEnergyOf(game.address, player.address)).to.equal(3n * MAX);
  });

  it("zero-address stake source disables the boost", async () => {
    const { stamina, admin, game, player, stakeToken } = await loadFixture(deployFixture);
    // enable then disable
    await stamina.connect(admin).setStakeBoost(
      game.address, await stakeToken.getAddress(), BOOST_ONE / 100n, 3n * BOOST_ONE
    );
    await stakeToken.mint(player.address, 100n);
    expect(await stamina.boostOf(game.address, player.address)).to.equal(2n * BOOST_ONE);

    await stamina.connect(admin).setStakeBoost(game.address, ZERO, 0n, BOOST_ONE);
    expect(await stamina.boostOf(game.address, player.address)).to.equal(BOOST_ONE);
    expect(await stamina.maxEnergyOf(game.address, player.address)).to.equal(MAX);
  });

  it("only GAME_ROLE can register; only ADMIN_ROLE can configure/remove", async () => {
    const { stamina, other, game } = await loadFixture(deployFixture);
    await expect(stamina.connect(other).registerGame(other.address, 1n, 1n))
      .to.be.revertedWithCustomError(stamina, "AccessControlUnauthorizedAccount");
    await expect(stamina.connect(other).updateGame(game.address, 1n, 1n))
      .to.be.revertedWithCustomError(stamina, "AccessControlUnauthorizedAccount");
    await expect(stamina.connect(other).removeGame(game.address))
      .to.be.revertedWithCustomError(stamina, "AccessControlUnauthorizedAccount");
  });

  it("rejects double registration and operations on unregistered games", async () => {
    const { stamina, admin, game, game2 } = await loadFixture(deployFixture);
    await expect(stamina.connect(admin).registerGame(game.address, MAX, REGEN))
      .to.be.revertedWithCustomError(stamina, "AlreadyRegistered");
    await expect(stamina.connect(admin).updateGame(game2.address, 1n, 1n))
      .to.be.revertedWithCustomError(stamina, "NotRegistered");
  });

  it("removeGame clears the meter config", async () => {
    const { stamina, admin, game, player } = await loadFixture(deployFixture);
    await stamina.connect(admin).removeGame(game.address);
    expect((await stamina.games(game.address)).registered).to.equal(false);
    // energyOf on an unregistered game returns 0
    expect(await stamina.energyOf(game.address, player.address)).to.equal(0n);
  });

  it("updateGame changes cap and regen", async () => {
    const { stamina, admin, game, player } = await loadFixture(deployFixture);
    await stamina.connect(game).spend(player.address, 500n); // 500 left
    await stamina.connect(admin).updateGame(game.address, 2000n, 20n);
    // cap raised; current energy unaffected until next touch, but capped reads use new max
    expect(await stamina.regenPerBlockOf(game.address, player.address)).to.equal(20n);
    expect((await stamina.games(game.address)).maxEnergy).to.equal(2000n);
  });
});
