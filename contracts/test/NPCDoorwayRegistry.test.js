const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const Kind = { OWNS_NFT: 0, MIN_STAT: 1, HOLDS_TOKEN: 2, REVEALED_SET: 3 };
const DOOR = ethers.id("temple-inner-door");
const KEY_STR = ethers.id("strength");
const ZERO_KEY = ethers.ZeroHash;
const ZERO = ethers.ZeroAddress;
const setIdToKey = (id) => ethers.zeroPadValue(ethers.toBeHex(id), 32);

describe("NPCDoorwayRegistry", function () {
  async function deployFixture() {
    const [admin, alice, bob] = await ethers.getSigners();

    // OWNS_NFT target: a soulbound ERC-721
    const SBT = await ethers.getContractFactory("SoulboundToken");
    const nft = await SBT.deploy("Badge", "BDG", admin.address);

    // HOLDS_TOKEN target: ERC-20
    const Mock = await ethers.getContractFactory("MockERC20");
    const erc20 = await Mock.deploy("Coin", "CN");

    // MIN_STAT target: MutableStatNFT
    const Stat = await ethers.getContractFactory("MutableStatNFT");
    const stat = await Stat.deploy("Stat", "ST", admin.address);

    // REVEALED_SET target: MonumentFragmentRegistry (fragments on `frag`)
    const frag = await SBT.deploy("Fragment", "FRG", admin.address);
    const Reg = await ethers.getContractFactory("MonumentFragmentRegistry");
    const corpus = await Reg.deploy(admin.address);

    const Door = await ethers.getContractFactory("NPCDoorwayRegistry");
    const door = await Door.deploy(admin.address);

    return { door, nft, erc20, stat, corpus, frag, admin, alice, bob };
  }

  // Build state so alice satisfies a given kind; returns the requirement.
  async function reqOwnsNft(ctx, holder) {
    await ctx.nft.connect(ctx.admin).mint(holder.address, "ipfs://b");
    return { kind: Kind.OWNS_NFT, target: await ctx.nft.getAddress(), idOrKey: ZERO_KEY, minValue: 1 };
  }

  describe("admin", function () {
    it("constructor grants ADMIN_ROLE", async () => {
      const { door, admin } = await loadFixture(deployFixture);
      expect(await door.hasRole(await door.ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("only ADMIN_ROLE can setDoorway", async () => {
      const { door, alice, erc20 } = await loadFixture(deployFixture);
      const reqs = [{ kind: Kind.HOLDS_TOKEN, target: await erc20.getAddress(), idOrKey: ZERO_KEY, minValue: 1 }];
      await expect(door.connect(alice).setDoorway(DOOR, reqs, false))
        .to.be.revertedWithCustomError(door, "AccessControlUnauthorizedAccount");
    });

    it("setDoorway stores reqs, hidden flag, and emits", async () => {
      const { door, admin, erc20 } = await loadFixture(deployFixture);
      const reqs = [{ kind: Kind.HOLDS_TOKEN, target: await erc20.getAddress(), idOrKey: ZERO_KEY, minValue: 5 }];
      await expect(door.connect(admin).setDoorway(DOOR, reqs, true))
        .to.emit(door, "DoorwaySet").withArgs(DOOR, 1, true);
      expect(await door.doorwayExists(DOOR)).to.equal(true);
      expect(await door.isHidden(DOOR)).to.equal(true);
      expect(await door.requirementCount(DOOR)).to.equal(1n);
      expect((await door.requirementAt(DOOR, 0)).minValue).to.equal(5n);
    });

    it("rejects empty req set and zero target", async () => {
      const { door, admin } = await loadFixture(deployFixture);
      await expect(door.connect(admin).setDoorway(DOOR, [], false))
        .to.be.revertedWithCustomError(door, "EmptyRequirements");
      await expect(door.connect(admin).setDoorway(DOOR, [
        { kind: Kind.OWNS_NFT, target: ZERO, idOrKey: ZERO_KEY, minValue: 1 },
      ], false)).to.be.revertedWithCustomError(door, "ZeroTarget").withArgs(0);
    });

    it("setHidden flips the flag; clearDoorway removes it", async () => {
      const { door, admin, erc20 } = await loadFixture(deployFixture);
      const reqs = [{ kind: Kind.HOLDS_TOKEN, target: await erc20.getAddress(), idOrKey: ZERO_KEY, minValue: 1 }];
      await door.connect(admin).setDoorway(DOOR, reqs, true);
      await expect(door.connect(admin).setHidden(DOOR, false))
        .to.emit(door, "DoorwayRevealedFlag").withArgs(DOOR, false);
      expect(await door.isHidden(DOOR)).to.equal(false);
      await expect(door.connect(admin).clearDoorway(DOOR))
        .to.emit(door, "DoorwayCleared").withArgs(DOOR);
      expect(await door.doorwayExists(DOOR)).to.equal(false);
      // gating after removal => false
      expect(await door.checkPassage(DOOR, admin.address, 0)).to.equal(false);
    });

    it("setHidden / clearDoorway on unknown door revert", async () => {
      const { door, admin } = await loadFixture(deployFixture);
      await expect(door.connect(admin).setHidden(DOOR, true))
        .to.be.revertedWithCustomError(door, "UnknownDoorway");
      await expect(door.connect(admin).clearDoorway(DOOR))
        .to.be.revertedWithCustomError(door, "UnknownDoorway");
    });
  });

  describe("requirement kinds — pass/fail", function () {
    it("OWNS_NFT", async () => {
      const ctx = await loadFixture(deployFixture);
      const { door, admin, alice, bob } = ctx;
      const r = await reqOwnsNft(ctx, alice);
      await door.connect(admin).setDoorway(DOOR, [r], false);
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(true);
      expect(await door.checkPassage(DOOR, bob.address, 0)).to.equal(false);
    });

    it("HOLDS_TOKEN", async () => {
      const { door, admin, alice, bob, erc20 } = await loadFixture(deployFixture);
      await door.connect(admin).setDoorway(DOOR, [
        { kind: Kind.HOLDS_TOKEN, target: await erc20.getAddress(), idOrKey: ZERO_KEY, minValue: 100 },
      ], false);
      await erc20.mint(alice.address, 100n);
      await erc20.mint(bob.address, 99n);
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(true);
      expect(await door.checkPassage(DOOR, bob.address, 0)).to.equal(false);
    });

    it("MIN_STAT reads MutableStatNFT.getStat via tokenIdHint", async () => {
      const { door, admin, alice, stat } = await loadFixture(deployFixture);
      await stat.connect(admin).mint(alice.address, 0n, "u"); // token 0
      await stat.connect(admin).setStat(0, KEY_STR, 50n);
      await door.connect(admin).setDoorway(DOOR, [
        { kind: Kind.MIN_STAT, target: await stat.getAddress(), idOrKey: KEY_STR, minValue: 50 },
      ], false);
      // hint = token 0 (meets threshold)
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(true);
      // raise threshold above stat
      await door.connect(admin).setDoorway(DOOR, [
        { kind: Kind.MIN_STAT, target: await stat.getAddress(), idOrKey: KEY_STR, minValue: 51 },
      ], false);
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(false);
    });

    it("REVEALED_SET reads MonumentFragmentRegistry.revealed", async () => {
      const { door, admin, alice, bob, corpus, frag } = await loadFixture(deployFixture);
      await frag.connect(admin).mint(alice.address, "u"); // fragment 0 -> alice
      const SET_ID = 3;
      await corpus.connect(admin).defineSet(SET_ID, await frag.getAddress(), [0], ethers.id("seg"));
      await corpus.connect(alice).claimReveal(SET_ID);

      await door.connect(admin).setDoorway(DOOR, [
        { kind: Kind.REVEALED_SET, target: await corpus.getAddress(), idOrKey: setIdToKey(SET_ID), minValue: 0 },
      ], false);
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(true);
      expect(await door.checkPassage(DOOR, bob.address, 0)).to.equal(false);
    });
  });

  describe("multi-requirement AND", function () {
    it("requires ALL kinds to pass together", async () => {
      const ctx = await loadFixture(deployFixture);
      const { door, admin, alice, erc20, stat } = ctx;
      // build alice up across NFT + ERC20 + stat
      const rNft = await reqOwnsNft(ctx, alice);
      await stat.connect(admin).mint(alice.address, 0n, "u"); // token 0
      await stat.connect(admin).setStat(0, KEY_STR, 10n);

      const reqs = [
        rNft,
        { kind: Kind.HOLDS_TOKEN, target: await erc20.getAddress(), idOrKey: ZERO_KEY, minValue: 1 },
        { kind: Kind.MIN_STAT, target: await stat.getAddress(), idOrKey: KEY_STR, minValue: 10 },
      ];
      await door.connect(admin).setDoorway(DOOR, reqs, false);

      // NFT + stat satisfied but no ERC20 yet => denied
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(false);
      // satisfy ERC20 leg => admitted
      await erc20.mint(alice.address, 1n);
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(true);
    });

    it("undefined doorway returns false", async () => {
      const { door, alice } = await loadFixture(deployFixture);
      expect(await door.checkPassage(DOOR, alice.address, 0)).to.equal(false);
    });
  });
});
