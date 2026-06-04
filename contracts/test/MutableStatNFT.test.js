const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const KEY_GOLD = ethers.id("gold");
const KEY_REP = ethers.id("reputation");
const ZERO = ethers.ZeroAddress;

describe("MutableStatNFT", function () {
  async function deployFixture() {
    const [admin, game, alice, bob] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("MutableStatNFT");
    const nft = await NFT.deploy("Mutable Stat", "MSTAT", admin.address);
    return { nft, admin, game, alice, bob };
  }

  async function withToken() {
    const ctx = await loadFixture(deployFixture);
    // token 0 minted to alice with genome 0xABCD
    await ctx.nft.connect(ctx.admin).mint(ctx.alice.address, 0xabcdn, "ipfs://tok0");
    return ctx;
  }

  describe("roles & mint", function () {
    it("constructor grants admin all three roles", async () => {
      const { nft, admin } = await loadFixture(deployFixture);
      expect(await nft.hasRole(await nft.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await nft.hasRole(await nft.MINTER_ROLE(), admin.address)).to.equal(true);
      expect(await nft.hasRole(await nft.STAT_WRITER_ROLE(), admin.address)).to.equal(true);
    });

    it("rejects zero admin in constructor", async () => {
      const NFT = await ethers.getContractFactory("MutableStatNFT");
      await expect(NFT.deploy("X", "X", ZERO)).to.be.revertedWithCustomError(NFT, "ZeroAddress");
    });

    it("only MINTER_ROLE can mint", async () => {
      const { nft, alice } = await loadFixture(deployFixture);
      await expect(nft.connect(alice).mint(alice.address, 1n, "u"))
        .to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount");
    });

    it("mint sets genome, uri, owner and emits Minted", async () => {
      const { nft, admin, alice } = await loadFixture(deployFixture);
      await expect(nft.connect(admin).mint(alice.address, 99n, "ipfs://x"))
        .to.emit(nft, "Minted").withArgs(0, alice.address, 99n);
      expect(await nft.ownerOf(0)).to.equal(alice.address);
      expect(await nft.genomeOf(0)).to.equal(99n);
      expect(await nft.tokenURI(0)).to.equal("ipfs://x");
      expect(await nft.minted()).to.equal(1n);
    });

    it("rejects mint to zero address", async () => {
      const { nft, admin } = await loadFixture(deployFixture);
      await expect(nft.connect(admin).mint(ZERO, 1n, "u"))
        .to.be.revertedWithCustomError(nft, "ZeroAddress");
    });
  });

  describe("stat writes (STAT_WRITER_ROLE)", function () {
    it("only STAT_WRITER_ROLE can setStat", async () => {
      const { nft, bob } = await withToken();
      await expect(nft.connect(bob).setStat(0, KEY_GOLD, 5n))
        .to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount");
    });

    it("a granted per-game writer can mutate stats", async () => {
      const { nft, admin, game } = await withToken();
      await nft.connect(admin).grantRole(await nft.STAT_WRITER_ROLE(), game.address);
      await expect(nft.connect(game).setStat(0, KEY_GOLD, 42n))
        .to.emit(nft, "StatChanged").withArgs(0, KEY_GOLD, 0n, 42n);
      expect(await nft.getStat(0, KEY_GOLD)).to.equal(42n);
    });

    it("setStat emits old and new value", async () => {
      const { nft, admin } = await withToken();
      await nft.connect(admin).setStat(0, KEY_GOLD, 10n);
      await expect(nft.connect(admin).setStat(0, KEY_GOLD, 7n))
        .to.emit(nft, "StatChanged").withArgs(0, KEY_GOLD, 10n, 7n);
    });

    it("setStats writes a batch and rejects length mismatch", async () => {
      const { nft, admin } = await withToken();
      await nft.connect(admin).setStats(0, [KEY_GOLD, KEY_REP], [3n, 4n]);
      const vals = await nft.getStats(0, [KEY_GOLD, KEY_REP]);
      expect(vals[0]).to.equal(3n);
      expect(vals[1]).to.equal(4n);
      await expect(nft.connect(admin).setStats(0, [KEY_GOLD], [1n, 2n]))
        .to.be.revertedWithCustomError(nft, "LengthMismatch");
    });

    it("incrementStat adds and returns new value", async () => {
      const { nft, admin } = await withToken();
      await nft.connect(admin).setStat(0, KEY_REP, 5n);
      await expect(nft.connect(admin).incrementStat(0, KEY_REP, 3n))
        .to.emit(nft, "StatChanged").withArgs(0, KEY_REP, 5n, 8n);
      expect(await nft.getStat(0, KEY_REP)).to.equal(8n);
    });

    it("setCore overwrites packed core and emits CoreChanged", async () => {
      const { nft, admin } = await withToken();
      const core = { level: 5, xp: 1000n, wear: 12, equippedItem: 777n };
      await expect(nft.connect(admin).setCore(0, core))
        .to.emit(nft, "CoreChanged").withArgs(0, 5, 1000n, 12, 777n);
      const c = await nft.getCore(0);
      expect(c.level).to.equal(5n);
      expect(c.xp).to.equal(1000n);
      expect(c.wear).to.equal(12n);
      expect(c.equippedItem).to.equal(777n);
    });

    it("writes to a nonexistent token revert", async () => {
      const { nft, admin } = await withToken();
      await expect(nft.connect(admin).setStat(999, KEY_GOLD, 1n))
        .to.be.revertedWithCustomError(nft, "NonexistentToken");
      await expect(nft.connect(admin).setCore(999, { level: 1, xp: 1n, wear: 1, equippedItem: 1n }))
        .to.be.revertedWithCustomError(nft, "NonexistentToken");
    });
  });

  describe("reads & persistence", function () {
    it("genome is immutable (no setter) and queryable", async () => {
      const { nft } = await withToken();
      expect(await nft.genomeOf(0)).to.equal(0xabcdn);
    });

    it("getStats returns zeros for unset keys", async () => {
      const { nft } = await withToken();
      const vals = await nft.getStats(0, [KEY_GOLD, KEY_REP]);
      expect(vals[0]).to.equal(0n);
      expect(vals[1]).to.equal(0n);
    });

    it("stats persist across distinct writer contracts (shared store)", async () => {
      const { nft, admin, game, alice } = await withToken();
      // simulate two games: admin acts as game A, `game` as game B
      await nft.connect(admin).grantRole(await nft.STAT_WRITER_ROLE(), game.address);
      await nft.connect(admin).setStat(0, KEY_GOLD, 100n); // game A
      await nft.connect(game).incrementStat(0, KEY_GOLD, 50n); // game B reads+writes same store
      expect(await nft.getStat(0, KEY_GOLD)).to.equal(150n);
      // ownership unaffected by stat writes
      expect(await nft.ownerOf(0)).to.equal(alice.address);
    });

    it("tokenURI reverts for nonexistent token", async () => {
      const { nft } = await withToken();
      await expect(nft.tokenURI(999)).to.be.revertedWithCustomError(nft, "NonexistentToken");
    });
  });
});
