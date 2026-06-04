const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Kind enum mirror (GateRegistry.Kind)
const Kind = { ERC20: 0, ERC721: 1, ERC1155: 2, SubscriptionKey: 3 };

const ROOM = ethers.id("general"); // bytes32 room id
const ZERO = ethers.ZeroAddress;

describe("GateRegistry", function () {
  async function deployFixture() {
    const [admin, alice, bob, treasury] = await ethers.getSigners();

    // ERC20 gate asset
    const Mock = await ethers.getContractFactory("MockERC20");
    const erc20 = await Mock.deploy("Gate20", "G20");

    // ERC721 gate asset (PranaNFT: admin holds MINTER_ROLE)
    const NFT = await ethers.getContractFactory("PranaNFT");
    const erc721 = await NFT.deploy(admin.address);

    // ERC1155 gate asset (ERC1155Base: admin holds MINTER_ROLE)
    const Multi = await ethers.getContractFactory("ERC1155Base");
    const erc1155 = await Multi.deploy("ipfs://base/", admin.address);

    // SubscriptionLockNFT key asset
    const pay = await Mock.deploy("Pay", "PAY");
    const PRICE = 100n;
    const PERIOD = 1000; // seconds
    const Sub = await ethers.getContractFactory("SubscriptionLockNFT");
    const sub = await Sub.deploy(await pay.getAddress(), PRICE, PERIOD, treasury.address);

    // The registry under test
    const Reg = await ethers.getContractFactory("GateRegistry");
    const reg = await Reg.deploy(admin.address);

    return {
      admin, alice, bob, treasury,
      erc20, erc721, erc1155, sub, pay,
      reg, PRICE, PERIOD,
    };
  }

  describe("admin", function () {
    it("constructor grants ADMIN_ROLE to admin", async () => {
      const { reg, admin } = await loadFixture(deployFixture);
      const ADMIN_ROLE = await reg.ADMIN_ROLE();
      expect(await reg.hasRole(ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it("only ADMIN_ROLE can set rules", async () => {
      const { reg, alice, erc20 } = await loadFixture(deployFixture);
      const reqs = [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 1 },
      ];
      await expect(reg.connect(alice).setRule(ROOM, reqs))
        .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
    });

    it("only ADMIN_ROLE can clear rules", async () => {
      const { reg, alice } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).clearRule(ROOM))
        .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
    });

    it("emits RuleSet and stores requirements", async () => {
      const { reg, admin, erc20 } = await loadFixture(deployFixture);
      const reqs = [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 50 },
      ];
      await expect(reg.connect(admin).setRule(ROOM, reqs))
        .to.emit(reg, "RuleSet").withArgs(ROOM, 1);
      expect(await reg.requirementCount(ROOM)).to.equal(1);
      const r = await reg.requirementAt(ROOM, 0);
      expect(r.token).to.equal(await erc20.getAddress());
      expect(r.kind).to.equal(Kind.ERC20);
      expect(r.minBalance).to.equal(50n);
    });

    it("setRule overwrites the prior set", async () => {
      const { reg, admin, erc20, erc721 } = await loadFixture(deployFixture);
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 1 },
        { token: await erc721.getAddress(), kind: Kind.ERC721, idOrMin: 0, minBalance: 1 },
      ]);
      expect(await reg.requirementCount(ROOM)).to.equal(2);
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 9 },
      ]);
      expect(await reg.requirementCount(ROOM)).to.equal(1);
      expect((await reg.requirementAt(ROOM, 0)).minBalance).to.equal(9n);
    });

    it("clearRule removes the rules and emits RuleCleared", async () => {
      const { reg, admin, erc20, alice } = await loadFixture(deployFixture);
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 1 },
      ]);
      await expect(reg.connect(admin).clearRule(ROOM))
        .to.emit(reg, "RuleCleared").withArgs(ROOM);
      expect(await reg.requirementCount(ROOM)).to.equal(0);
      // no rules => no access
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(false);
    });

    it("rejects an empty requirement set", async () => {
      const { reg, admin } = await loadFixture(deployFixture);
      await expect(reg.connect(admin).setRule(ROOM, []))
        .to.be.revertedWithCustomError(reg, "EmptyRequirements");
    });

    it("rejects a zero token address", async () => {
      const { reg, admin } = await loadFixture(deployFixture);
      await expect(reg.connect(admin).setRule(ROOM, [
        { token: ZERO, kind: Kind.ERC20, idOrMin: 0, minBalance: 1 },
      ])).to.be.revertedWithCustomError(reg, "ZeroToken").withArgs(0);
    });

    it("rejects zero minBalance for balance-based kinds", async () => {
      const { reg, admin, erc20 } = await loadFixture(deployFixture);
      await expect(reg.connect(admin).setRule(ROOM, [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 0 },
      ])).to.be.revertedWithCustomError(reg, "BadMinBalance").withArgs(0);
    });
  });

  describe("ERC20 min-balance gate", function () {
    it("admits only accounts at/above the threshold", async () => {
      const { reg, admin, alice, bob, erc20 } = await loadFixture(deployFixture);
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 100 },
      ]);
      await erc20.mint(alice.address, 100n); // exactly meets
      await erc20.mint(bob.address, 99n); // just under

      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(true);
      expect(await reg.checkAccess(ROOM, bob.address)).to.equal(false);
    });
  });

  describe("ERC721 ownership gate", function () {
    it("admits holders of at least one NFT", async () => {
      const { reg, admin, alice, bob, erc721 } = await loadFixture(deployFixture);
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc721.getAddress(), kind: Kind.ERC721, idOrMin: 0, minBalance: 1 },
      ]);
      await erc721.connect(admin).mint(alice.address, "ipfs://1");

      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(true);
      expect(await reg.checkAccess(ROOM, bob.address)).to.equal(false);
    });
  });

  describe("ERC1155 id gate", function () {
    it("admits holders of >= minBalance of a specific id", async () => {
      const { reg, admin, alice, bob, erc1155 } = await loadFixture(deployFixture);
      const ID = 7;
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc1155.getAddress(), kind: Kind.ERC1155, idOrMin: ID, minBalance: 5 },
      ]);
      await erc1155.connect(admin).mint(alice.address, ID, 5, "0x");
      await erc1155.connect(admin).mint(bob.address, ID, 4, "0x"); // under
      // holding a different id should not count
      await erc1155.connect(admin).mint(bob.address, 8, 100, "0x");

      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(true);
      expect(await reg.checkAccess(ROOM, bob.address)).to.equal(false);
    });
  });

  describe("SubscriptionKey gate", function () {
    async function buyKey(sub, pay, buyer, price) {
      await pay.mint(buyer.address, price);
      await pay.connect(buyer).approve(await sub.getAddress(), price);
      const tx = await sub.connect(buyer).purchase(buyer.address);
      await tx.wait();
    }

    it("admits the owner of a valid (unexpired) key, denies others", async () => {
      const { reg, admin, alice, bob, sub, pay, PRICE } = await loadFixture(deployFixture);
      await buyKey(sub, pay, alice, PRICE); // key id 0 -> alice
      await reg.connect(admin).setRule(ROOM, [
        { token: await sub.getAddress(), kind: Kind.SubscriptionKey, idOrMin: 0, minBalance: 0 },
      ]);

      expect(await sub.isValid(0)).to.equal(true);
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(true);
      // bob does not own key 0
      expect(await reg.checkAccess(ROOM, bob.address)).to.equal(false);
    });

    it("denies access once the key expires", async () => {
      const { reg, admin, alice, sub, pay, PRICE, PERIOD } = await loadFixture(deployFixture);
      await buyKey(sub, pay, alice, PRICE);
      await reg.connect(admin).setRule(ROOM, [
        { token: await sub.getAddress(), kind: Kind.SubscriptionKey, idOrMin: 0, minBalance: 0 },
      ]);
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(true);

      await time.increase(PERIOD + 1);
      expect(await sub.isValid(0)).to.equal(false);
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(false);
    });

    it("denies access for a nonexistent key id (no revert)", async () => {
      const { reg, admin, alice, sub } = await loadFixture(deployFixture);
      await reg.connect(admin).setRule(ROOM, [
        { token: await sub.getAddress(), kind: Kind.SubscriptionKey, idOrMin: 999, minBalance: 0 },
      ]);
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(false);
    });
  });

  describe("multi-requirement AND logic", function () {
    it("requires ALL requirements to pass", async () => {
      const { reg, admin, alice, erc20, erc721 } = await loadFixture(deployFixture);
      await reg.connect(admin).setRule(ROOM, [
        { token: await erc20.getAddress(), kind: Kind.ERC20, idOrMin: 0, minBalance: 100 },
        { token: await erc721.getAddress(), kind: Kind.ERC721, idOrMin: 0, minBalance: 1 },
      ]);

      // only the ERC20 leg satisfied -> denied
      await erc20.mint(alice.address, 100n);
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(false);

      // now satisfy the ERC721 leg too -> admitted
      await erc721.connect(admin).mint(alice.address, "ipfs://x");
      expect(await reg.checkAccess(ROOM, alice.address)).to.equal(true);
    });
  });
});
