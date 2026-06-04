const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const k = (s) => ethers.encodeBytes32String(s);
const SEASON_LEN = 7 * 24 * 60 * 60; // 1 week
const TOP_N = 4;
const GRACE = 24 * 60 * 60;
const DEFAULT_BPS = [5000, 3000, 2000];

describe("ArcadeLeaderboard", function () {
  async function deployFixture() {
    const [admin, attester, alice, bob, carol, dave, funder] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Prize", "PRZ");

    const Factory = await ethers.getContractFactory("ArcadeLeaderboard");
    const board = await Factory.deploy(admin.address, GRACE);
    await board.waitForDeployment();

    const GAME = k("clash");
    await board.registerGame(GAME, TOP_N, SEASON_LEN, attester.address, DEFAULT_BPS);

    return { board, token, admin, attester, alice, bob, carol, dave, funder, GAME };
  }

  async function signScore(board, signer, v) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "ArcadeLeaderboard",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await board.getAddress(),
    };
    const types = {
      Score: [
        { name: "player", type: "address" },
        { name: "gameId", type: "bytes32" },
        { name: "season", type: "uint256" },
        { name: "score", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, v);
  }

  async function post(board, attester, GAME, player, season, score, nonce) {
    const now = await time.latest();
    const v = { player, gameId: GAME, season, score, nonce, deadline: BigInt(now + 3600) };
    const sig = await signScore(board, attester, v);
    return board.postScore(v.player, v.gameId, v.season, v.score, v.nonce, v.deadline, sig);
  }

  it("registers a game and exposes config", async () => {
    const { board, attester, GAME } = await loadFixture(deployFixture);
    const g = await board.getGame(GAME);
    expect(g.topN).to.equal(TOP_N);
    expect(g.seasonLength).to.equal(SEASON_LEN);
    expect(g.attester).to.equal(attester.address);
    expect(g.rankBps.map(Number)).to.deep.equal(DEFAULT_BPS);
  });

  it("rejects re-registration, bad topN, bad bps sum", async () => {
    const { board, attester, admin } = await loadFixture(deployFixture);
    const G2 = k("g2");
    await expect(board.registerGame(k("clash"), TOP_N, SEASON_LEN, attester.address, DEFAULT_BPS))
      .to.be.revertedWithCustomError(board, "AlreadyRegistered");
    await expect(board.registerGame(G2, 0, SEASON_LEN, attester.address, DEFAULT_BPS))
      .to.be.revertedWithCustomError(board, "BadTopN");
    await expect(board.registerGame(G2, 100, SEASON_LEN, attester.address, DEFAULT_BPS))
      .to.be.revertedWithCustomError(board, "BadTopN");
    await expect(board.registerGame(G2, TOP_N, SEASON_LEN, attester.address, [4000, 3000, 2000]))
      .to.be.revertedWithCustomError(board, "BadBps");
  });

  it("posts a valid score voucher", async () => {
    const { board, attester, alice, GAME } = await loadFixture(deployFixture);
    const season = await board.currentSeason(GAME);
    await expect(post(board, attester, GAME, alice.address, season, 100n, 1n))
      .to.emit(board, "ScorePosted")
      .withArgs(GAME, season, alice.address, 100n, 0);
    const b = await board.getBoard(GAME, season);
    expect(b.length).to.equal(1);
    expect(b[0].player).to.equal(alice.address);
    expect(b[0].score).to.equal(100n);
  });

  it("rejects replayed nonce", async () => {
    const { board, attester, alice, GAME } = await loadFixture(deployFixture);
    const season = await board.currentSeason(GAME);
    await post(board, attester, GAME, alice.address, season, 100n, 1n);
    await expect(post(board, attester, GAME, alice.address, season, 200n, 1n))
      .to.be.revertedWithCustomError(board, "NonceAlreadyUsed");
  });

  it("rejects wrong attester", async () => {
    const { board, bob, alice, GAME } = await loadFixture(deployFixture);
    const season = await board.currentSeason(GAME);
    await expect(post(board, bob, GAME, alice.address, season, 100n, 1n))
      .to.be.revertedWithCustomError(board, "BadSigner");
  });

  it("rejects expired voucher", async () => {
    const { board, attester, alice, GAME } = await loadFixture(deployFixture);
    const season = await board.currentSeason(GAME);
    const now = await time.latest();
    const v = { player: alice.address, gameId: GAME, season, score: 5n, nonce: 9n, deadline: BigInt(now - 1) };
    const sig = await signScore(board, attester, v);
    await expect(board.postScore(v.player, v.gameId, v.season, v.score, v.nonce, v.deadline, sig))
      .to.be.revertedWithCustomError(board, "VoucherExpired");
  });

  it("orders top-N descending with insertion and displaces the lowest when full", async () => {
    const { board, attester, alice, bob, carol, dave, funder, GAME } = await loadFixture(deployFixture);
    const season = await board.currentSeason(GAME);
    // Fill the 4-slot board out of order.
    await post(board, attester, GAME, alice.address, season, 50n, 1n);
    await post(board, attester, GAME, bob.address, season, 90n, 2n);
    await post(board, attester, GAME, carol.address, season, 70n, 3n);
    await post(board, attester, GAME, dave.address, season, 30n, 4n);
    let b = await board.getBoard(GAME, season);
    expect(b.map((e) => Number(e.score))).to.deep.equal([90, 70, 50, 30]);
    expect(b.map((e) => e.player)).to.deep.equal([bob.address, carol.address, alice.address, dave.address]);

    // A high score displaces the lowest (dave/30).
    await post(board, attester, GAME, funder.address, season, 80n, 5n);
    b = await board.getBoard(GAME, season);
    expect(b.map((e) => Number(e.score))).to.deep.equal([90, 80, 70, 50]);
    expect(b.length).to.equal(4);

    // A score below the cutoff does not make the board.
    await post(board, attester, GAME, dave.address, season, 10n, 6n);
    b = await board.getBoard(GAME, season);
    expect(b.map((e) => Number(e.score))).to.deep.equal([90, 80, 70, 50]);
  });

  it("season rollover isolates boards", async () => {
    const { board, attester, alice, GAME } = await loadFixture(deployFixture);
    const s0 = await board.currentSeason(GAME);
    await post(board, attester, GAME, alice.address, s0, 100n, 1n);
    await time.increase(SEASON_LEN);
    const s1 = await board.currentSeason(GAME);
    expect(s1).to.equal(s0 + 1n);
    expect((await board.getBoard(GAME, s1)).length).to.equal(0);
    expect((await board.getBoard(GAME, s0)).length).to.equal(1);
  });

  async function fundedSeasonFixture() {
    const base = await deployFixture();
    const { board, token, attester, alice, bob, carol, funder, GAME } = base;
    const season = await board.currentSeason(GAME);

    await post(board, attester, GAME, alice.address, season, 90n, 1n); // rank 0
    await post(board, attester, GAME, bob.address, season, 70n, 2n); // rank 1
    await post(board, attester, GAME, carol.address, season, 50n, 3n); // rank 2

    await token.mint(funder.address, 10_000n);
    await token.connect(funder).approve(await board.getAddress(), 10_000n);
    await board.connect(funder).fundPool(GAME, season, await token.getAddress(), 10_000n);

    return { ...base, season };
  }

  it("funds a pool and enforces single token per pool", async () => {
    const { board, token, funder, GAME, season } = await loadFixture(fundedSeasonFixture);
    const p = await board.getPool(GAME, season);
    expect(p.token).to.equal(await token.getAddress());
    expect(p.total).to.equal(10_000n);

    const Mock = await ethers.getContractFactory("MockERC20");
    const other = await Mock.deploy("Other", "OTH");
    await other.mint(funder.address, 5n);
    await other.connect(funder).approve(await board.getAddress(), 5n);
    await expect(board.connect(funder).fundPool(GAME, season, await other.getAddress(), 5n))
      .to.be.revertedWithCustomError(board, "PoolTokenMismatch");
  });

  it("claimPrize reverts before season end", async () => {
    const { board, GAME, season } = await loadFixture(fundedSeasonFixture);
    await expect(board.claimPrize(GAME, season, 0))
      .to.be.revertedWithCustomError(board, "SeasonNotEnded");
  });

  it("ranked players claim their bps split after season ends; double-claim reverts", async () => {
    const { board, token, alice, bob, carol, GAME, season } = await loadFixture(fundedSeasonFixture);
    await time.increase(SEASON_LEN);

    await expect(board.claimPrize(GAME, season, 0))
      .to.emit(board, "PrizeClaimed").withArgs(GAME, season, 0, alice.address, 5000n);
    await board.claimPrize(GAME, season, 1);
    await board.claimPrize(GAME, season, 2);

    expect(await token.balanceOf(alice.address)).to.equal(5000n);
    expect(await token.balanceOf(bob.address)).to.equal(3000n);
    expect(await token.balanceOf(carol.address)).to.equal(2000n);

    await expect(board.claimPrize(GAME, season, 0))
      .to.be.revertedWithCustomError(board, "AlreadyClaimed");
  });

  it("claim reverts for an empty rank and a rank beyond bps", async () => {
    const { board, GAME, season } = await loadFixture(fundedSeasonFixture);
    await time.increase(SEASON_LEN);
    // rank 3 has no bps entry (DEFAULT_BPS has 3 entries -> ranks 0..2).
    await expect(board.claimPrize(GAME, season, 3))
      .to.be.revertedWithCustomError(board, "NotRanked");
  });

  it("sweep reverts before grace, succeeds after, capped at pool total", async () => {
    const { board, token, admin, alice, GAME, season } = await loadFixture(fundedSeasonFixture);
    // Land just past the season-end boundary so grace is measured from a known point.
    const seasonEnd = (Number(season) + 1) * SEASON_LEN;
    await time.increaseTo(seasonEnd); // season ended

    // Grace not yet elapsed.
    await expect(board.sweepPool(GAME, season, admin.address))
      .to.be.revertedWithCustomError(board, "GraceNotElapsed");

    // Alice claims rank 0 (5000) before sweep.
    await board.claimPrize(GAME, season, 0);

    await time.increaseTo(seasonEnd + GRACE);
    await expect(board.sweepPool(GAME, season, admin.address))
      .to.emit(board, "PoolSwept").withArgs(GAME, season, admin.address, 5000n);
    expect(await token.balanceOf(admin.address)).to.equal(5000n);
    expect(await token.balanceOf(alice.address)).to.equal(5000n);

    // Pool now empty.
    await expect(board.sweepPool(GAME, season, admin.address))
      .to.be.revertedWithCustomError(board, "NoPool");
  });

  it("non-admin cannot register or sweep", async () => {
    const { board, attester, alice, GAME, season } = await loadFixture(fundedSeasonFixture);
    await expect(board.connect(alice).registerGame(k("x"), TOP_N, SEASON_LEN, attester.address, DEFAULT_BPS))
      .to.be.reverted;
    await time.increase(SEASON_LEN + GRACE);
    await expect(board.connect(alice).sweepPool(GAME, season, alice.address))
      .to.be.reverted;
  });
});
