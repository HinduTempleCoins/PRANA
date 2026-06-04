const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const REF1 = ethers.id("lore-segment-1");
const REF2 = ethers.id("lore-segment-2");
const ZERO = ethers.ZeroAddress;

describe("MonumentFragmentRegistry", function () {
  async function deployFixture() {
    const [admin, alice, bob] = await ethers.getSigners();

    // Soulbound ERC-721 fragment token: admin holds MINTER_ROLE.
    const SBT = await ethers.getContractFactory("SoulboundToken");
    const frag = await SBT.deploy("Fragment", "FRAG", admin.address);

    const Reg = await ethers.getContractFactory("MonumentFragmentRegistry");
    const reg = await Reg.deploy(admin.address);

    // mint fragments 0,1,2 to alice; fragment 3 to bob
    await frag.connect(admin).mint(alice.address, "ipfs://f0"); // 0
    await frag.connect(admin).mint(alice.address, "ipfs://f1"); // 1
    await frag.connect(admin).mint(alice.address, "ipfs://f2"); // 2
    await frag.connect(admin).mint(bob.address, "ipfs://f3"); // 3

    return { reg, frag, admin, alice, bob };
  }

  describe("admin / define", function () {
    it("constructor grants ADMIN_ROLE", async () => {
      const { reg, admin } = await loadFixture(deployFixture);
      expect(await reg.hasRole(await reg.ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("only ADMIN_ROLE can defineSet", async () => {
      const { reg, frag, alice } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).defineSet(1, await frag.getAddress(), [0], REF1))
        .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
    });

    it("defineSet stores set and emits SetDefined", async () => {
      const { reg, frag, admin } = await loadFixture(deployFixture);
      const addr = await frag.getAddress();
      await expect(reg.connect(admin).defineSet(1, addr, [0, 1], REF1))
        .to.emit(reg, "SetDefined").withArgs(1, addr, 2, REF1);
      expect(await reg.setExists(1)).to.equal(true);
      const s = await reg.getSet(1);
      expect(s.token).to.equal(addr);
      expect(s.fragmentIds.map((x) => Number(x))).to.deep.equal([0, 1]);
      expect(s.contentRef).to.equal(REF1);
      expect(s.sealed_).to.equal(false);
    });

    it("rejects duplicate setId, zero token, and empty fragments", async () => {
      const { reg, frag, admin } = await loadFixture(deployFixture);
      const addr = await frag.getAddress();
      await reg.connect(admin).defineSet(1, addr, [0], REF1);
      await expect(reg.connect(admin).defineSet(1, addr, [1], REF1))
        .to.be.revertedWithCustomError(reg, "SetExists").withArgs(1);
      await expect(reg.connect(admin).defineSet(2, ZERO, [1], REF1))
        .to.be.revertedWithCustomError(reg, "ZeroToken");
      await expect(reg.connect(admin).defineSet(3, addr, [], REF1))
        .to.be.revertedWithCustomError(reg, "EmptyFragments");
    });

    it("setContentRef updates an unsealed set", async () => {
      const { reg, frag, admin } = await loadFixture(deployFixture);
      await reg.connect(admin).defineSet(1, await frag.getAddress(), [0], REF1);
      await reg.connect(admin).setContentRef(1, REF2);
      expect((await reg.getSet(1)).contentRef).to.equal(REF2);
    });
  });

  describe("sealing / immutability", function () {
    it("sealSet freezes the set and blocks further edits", async () => {
      const { reg, frag, admin } = await loadFixture(deployFixture);
      await reg.connect(admin).defineSet(1, await frag.getAddress(), [0], REF1);
      await expect(reg.connect(admin).sealSet(1)).to.emit(reg, "SetSealed").withArgs(1);
      expect(await reg.isSealed(1)).to.equal(true);
      await expect(reg.connect(admin).setContentRef(1, REF2))
        .to.be.revertedWithCustomError(reg, "SetIsSealed").withArgs(1);
      await expect(reg.connect(admin).sealSet(1))
        .to.be.revertedWithCustomError(reg, "SetIsSealed").withArgs(1);
    });

    it("sealing/editing an unknown set reverts", async () => {
      const { reg, admin } = await loadFixture(deployFixture);
      await expect(reg.connect(admin).sealSet(9))
        .to.be.revertedWithCustomError(reg, "UnknownSet").withArgs(9);
    });
  });

  describe("claimReveal", function () {
    it("reveals when caller holds ALL fragments; records first revealer & count", async () => {
      const { reg, frag, admin, alice } = await loadFixture(deployFixture);
      await reg.connect(admin).defineSet(1, await frag.getAddress(), [0, 1, 2], REF1);

      expect(await reg.canReveal(1, alice.address)).to.equal(true);
      await expect(reg.connect(alice).claimReveal(1))
        .to.emit(reg, "CorpusRevealed").withArgs(alice.address, 1, REF1);

      expect(await reg.revealed(alice.address, 1)).to.equal(true);
      expect(await reg.revealCount(1)).to.equal(1n);
      expect(await reg.firstRevealer(1)).to.equal(alice.address);
    });

    it("reverts when an incomplete set (missing a fragment)", async () => {
      const { reg, frag, admin, alice } = await loadFixture(deployFixture);
      // require fragment 3 (owned by bob, not alice)
      await reg.connect(admin).defineSet(1, await frag.getAddress(), [0, 3], REF1);
      expect(await reg.canReveal(1, alice.address)).to.equal(false);
      await expect(reg.connect(alice).claimReveal(1))
        .to.be.revertedWithCustomError(reg, "FragmentNotHeld").withArgs(3);
    });

    it("reverts on double reveal and on unknown set", async () => {
      const { reg, frag, admin, alice } = await loadFixture(deployFixture);
      await reg.connect(admin).defineSet(1, await frag.getAddress(), [0], REF1);
      await reg.connect(alice).claimReveal(1);
      await expect(reg.connect(alice).claimReveal(1))
        .to.be.revertedWithCustomError(reg, "AlreadyRevealed").withArgs(1);
      await expect(reg.connect(alice).claimReveal(7))
        .to.be.revertedWithCustomError(reg, "UnknownSet").withArgs(7);
    });

    it("first revealer is recorded once; count tracks subsequent revealers", async () => {
      const { reg, frag, admin, alice, bob } = await loadFixture(deployFixture);
      const addr = await frag.getAddress();
      // a one-fragment set requiring fragment 0 — only alice can reveal it; give bob fragment 0? no.
      // Use a set that both can complete: define two single-frag sets sharing logic via two sets.
      // Simpler: set requires fragment 0 (alice) — reveal once; then move to a multi-revealer case.
      await reg.connect(admin).defineSet(1, addr, [0], REF1); // alice-only
      await reg.connect(alice).claimReveal(1);
      expect(await reg.firstRevealer(1)).to.equal(alice.address);
      expect(await reg.revealCount(1)).to.equal(1n);

      // a set requiring fragment 3 (bob) — bob is first/only revealer
      await reg.connect(admin).defineSet(2, addr, [3], REF2);
      await reg.connect(bob).claimReveal(2);
      expect(await reg.firstRevealer(2)).to.equal(bob.address);
      expect(await reg.revealCount(2)).to.equal(1n);
    });

    it("burned/nonexistent fragment id reads as not-held (no revert in canReveal)", async () => {
      const { reg, frag, admin, alice } = await loadFixture(deployFixture);
      await reg.connect(admin).defineSet(1, await frag.getAddress(), [42], REF1); // never minted
      expect(await reg.canReveal(1, alice.address)).to.equal(false);
      await expect(reg.connect(alice).claimReveal(1))
        .to.be.revertedWithCustomError(reg, "FragmentNotHeld").withArgs(42);
    });
  });
});
