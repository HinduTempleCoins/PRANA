const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PullPayment (PullPaymentsBase via DemoPullSplitter)", function () {
  let splitter, deployer, payeeA, payeeB, funder;

  beforeEach(async () => {
    [deployer, payeeA, payeeB, funder] = await ethers.getSigners();
    const S = await ethers.getContractFactory("DemoPullSplitter");
    splitter = await S.deploy(payeeA.address, payeeB.address);
  });

  describe("native", () => {
    it("escrows accrual 50/50 and lets each payee pull", async () => {
      await splitter.connect(funder).splitNative({ value: 100n });
      expect(await splitter.payments(payeeA.address)).to.equal(50n);
      expect(await splitter.payments(payeeB.address)).to.equal(50n);

      const before = await ethers.provider.getBalance(payeeA.address);
      // payeeB triggers payeeA's withdrawal (anyone may trigger; funds go to payeeA)
      await expect(splitter.connect(payeeB).withdrawPayments(payeeA.address))
        .to.emit(splitter, "NativePaymentWithdrawn")
        .withArgs(payeeA.address, 50n);
      const after = await ethers.provider.getBalance(payeeA.address);
      expect(after - before).to.equal(50n);
      expect(await splitter.payments(payeeA.address)).to.equal(0n);
    });

    it("accumulates across multiple escrows", async () => {
      await splitter.connect(funder).splitNative({ value: 100n });
      await splitter.connect(funder).splitNative({ value: 40n });
      expect(await splitter.payments(payeeA.address)).to.equal(70n);
    });

    it("reverts withdraw when nothing is owed", async () => {
      await expect(
        splitter.withdrawPayments(payeeA.address)
      ).to.be.revertedWithCustomError(splitter, "NoPayment");
    });

    it("is re-entrancy-safe: attacker cannot double-pay", async () => {
      const A = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await A.deploy();
      const attackerAddr = await attacker.getAddress();

      // Credit the attacker contract a native payment.
      // splitNative credits payeeA (=attacker) and payeeB; redeploy with attacker as payeeA.
      const S = await ethers.getContractFactory("DemoPullSplitter");
      const sp = await S.deploy(attackerAddr, payeeB.address);
      await sp.connect(funder).splitNative({ value: 100n });
      expect(await sp.payments(attackerAddr)).to.equal(50n);

      // Arm the attacker to re-enter withdrawPayments(attacker) from inside its receive().
      const payload = sp.interface.encodeFunctionData("withdrawPayments", [attackerAddr]);
      await attacker.arm(await sp.getAddress(), payload, 3);

      const spBalBefore = await ethers.provider.getBalance(await sp.getAddress());
      // Kick off the first (legitimate) withdrawal via the attacker's fire().
      await attacker.fire(
        await sp.getAddress(),
        sp.interface.encodeFunctionData("withdrawPayments", [attackerAddr])
      );

      // Re-entry was attempted but must have failed (balance zeroed → NoPayment).
      expect(await attacker.reenterAttempted()).to.equal(true);
      expect(await attacker.reenterSucceeded()).to.equal(false);

      // Attacker received exactly its 50, not more; splitter still holds payeeB's 50.
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(50n);
      expect(await ethers.provider.getBalance(await sp.getAddress())).to.equal(
        spBalBefore - 50n
      );
      expect(await sp.payments(attackerAddr)).to.equal(0n);
      expect(await sp.payments(payeeB.address)).to.equal(50n);
    });
  });

  describe("erc-20", () => {
    let token;
    beforeEach(async () => {
      const T = await ethers.getContractFactory("MockERC20");
      token = await T.deploy("Tok", "TOK");
      await token.mint(funder.address, 10_000n);
      await token.connect(funder).approve(await splitter.getAddress(), 10_000n);
    });

    it("escrows token accrual 50/50 and lets each payee pull", async () => {
      await splitter.connect(funder).splitToken(await token.getAddress(), 1000n);
      const tAddr = await token.getAddress();
      expect(await splitter.tokenPayments(tAddr, payeeA.address)).to.equal(500n);
      expect(await splitter.tokenPayments(tAddr, payeeB.address)).to.equal(500n);

      await expect(splitter.withdrawTokenPayments(tAddr, payeeA.address))
        .to.emit(splitter, "TokenPaymentWithdrawn")
        .withArgs(tAddr, payeeA.address, 500n);
      expect(await token.balanceOf(payeeA.address)).to.equal(500n);
      expect(await splitter.tokenPayments(tAddr, payeeA.address)).to.equal(0n);
    });

    it("reverts token withdraw when nothing is owed", async () => {
      await expect(
        splitter.withdrawTokenPayments(await token.getAddress(), payeeA.address)
      ).to.be.revertedWithCustomError(splitter, "NoPayment");
    });
  });
});
