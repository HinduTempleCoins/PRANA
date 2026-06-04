const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Adversarial: non-standard ERC-20 inputs.
 *
 * We feed three sink/stake contracts (BurnMine, UsageBurn, LiquidityGauge) tokens that
 * violate the "amount sent == amount received" assumption:
 *   - FeeOnTransferToken: skims a fee on every transfer, so the receiver gets LESS.
 *   - RebasingToken: a global multiplier silently changes recorded balances after deposit.
 *
 * The question for each: does internal accounting stay safe (no over-credit: the contract
 * must never credit a user with more value than actually arrived)? We assert the behavior
 * each contract *actually* implements. Where a contract over-credits, the test documents it
 * with a loud `// FINDING:` comment instead of pretending it's fine.
 */
describe("Adversarial: non-standard ERC-20 accounting", function () {
  const FEE_BPS = 100n; // 1% skim
  const BPS = 10_000n;

  // ----------------------------------------------------------------- //
  //  BurnMine                                                         //
  // ----------------------------------------------------------------- //
  describe("BurnMine with a fee-on-transfer input", function () {
    async function fix() {
      const [admin, user] = await ethers.getSigners();

      const FoT = await ethers.getContractFactory("FeeOnTransferToken");
      const input = await FoT.deploy("FeeIn", "FIN", FEE_BPS);

      const PoL = await ethers.getContractFactory("PoLToken");
      const output = await PoL.deploy(admin.address);

      const Mine = await ethers.getContractFactory("BurnMine");
      // ratio 1:1 so quote(amountIn) == amountIn
      const mine = await Mine.deploy(
        await input.getAddress(),
        await output.getAddress(),
        1n,
        1n
      );
      await output.grantRole(await output.MINTER_ROLE(), await mine.getAddress());

      await input.mint(user.address, 1000n);
      await input.connect(user).approve(await mine.getAddress(), 1000n);
      return { input, output, mine, admin, user };
    }

    it("does NOT over-credit: the mine reverts because it cannot burn the full amountIn", async function () {
      const { mine, user } = await loadFixture(fix);
      // mine() pulls amountIn (1% skimmed in transit), then tries input.burn(amountIn).
      // The mine received only 990, so burn(1000) reverts on insufficient balance.
      // SAFE: the whole tx reverts; no output is minted, no over-credit.
      await expect(mine.connect(user).mine(1000n)).to.be.reverted;
    });

    it("mints nothing and burns nothing when it reverts (state untouched)", async function () {
      const { mine, output, user } = await loadFixture(fix);
      await expect(mine.connect(user).mine(1000n)).to.be.reverted;
      expect(await output.balanceOf(user.address)).to.equal(0n);
      expect(await mine.totalMinted()).to.equal(0n);
      expect(await mine.totalBurned()).to.equal(0n);
    });
  });

  // ----------------------------------------------------------------- //
  //  UsageBurn                                                        //
  // ----------------------------------------------------------------- //
  describe("UsageBurn with a fee-on-transfer token", function () {
    async function fix() {
      const [admin, user] = await ethers.getSigners();
      const FoT = await ethers.getContractFactory("FeeOnTransferToken");
      const token = await FoT.deploy("FeeUse", "FUSE", FEE_BPS);
      const UB = await ethers.getContractFactory("UsageBurn");
      const gate = await UB.deploy(await token.getAddress());
      await token.mint(user.address, 1000n);
      await token.connect(user).approve(await gate.getAddress(), 1000n);
      return { token, gate, user };
    }

    it("is safe: burnFrom consumes exactly `amount` from the user (no transfer hop to skim)", async function () {
      const { token, gate, user } = await loadFixture(fix);
      // UsageBurn calls token.burnFrom(user, amount): a burn is a transfer TO the zero
      // address, which the fee token does not skim. So exactly `amount` leaves the user and
      // exactly `amount` is tallied. No mismatch — the burn IS the accounting.
      await gate.connect(user).use(300n, ethers.ZeroHash);
      expect(await token.balanceOf(user.address)).to.equal(700n);
      expect(await gate.burnedBy(user.address)).to.equal(300n);
      expect(await gate.totalBurned()).to.equal(300n);
      // The tally never exceeds what actually left the user's balance.
      expect(await gate.totalBurned()).to.equal(1000n - (await token.balanceOf(user.address)));
    });
  });

  // ----------------------------------------------------------------- //
  //  LiquidityGauge                                                   //
  // ----------------------------------------------------------------- //
  describe("LiquidityGauge with a fee-on-transfer stake token", function () {
    async function fix() {
      const [admin, dist, alice, bob] = await ethers.getSigners();
      const FoT = await ethers.getContractFactory("FeeOnTransferToken");
      const stakeT = await FoT.deploy("FeeLP", "FLP", FEE_BPS);

      const Mock = await ethers.getContractFactory("MockERC20");
      const rewardT = await Mock.deploy("Rew", "REW");

      const G = await ethers.getContractFactory("LiquidityGauge");
      const gauge = await G.deploy(
        await stakeT.getAddress(),
        await rewardT.getAddress(),
        dist.address
      );

      await stakeT.mint(alice.address, 1000n);
      await stakeT.mint(bob.address, 1000n);
      await stakeT.connect(alice).approve(await gauge.getAddress(), 1000n);
      await stakeT.connect(bob).approve(await gauge.getAddress(), 1000n);
      return { stakeT, rewardT, gauge, dist, alice, bob };
    }

    it("FINDING: over-credits the staker — balanceOf records the requested amount, not the received amount", async function () {
      const { stakeT, gauge, alice } = await loadFixture(fix);

      // FINDING (over-credit): LiquidityGauge.stake() does
      //     balanceOf[msg.sender] += amount;   // credited BEFORE the transfer
      //     stakeToken.safeTransferFrom(msg.sender, address(this), amount);
      // With a fee-on-transfer token the gauge actually receives `amount - fee`, but it
      // credits the full `amount`. The staker is over-credited by the fee, and totalSupply
      // exceeds the gauge's real token balance. A standard (StakingRewards) gauge inherits
      // this; the documented mitigation is to disallow fee-on-transfer stake tokens or to
      // measure the balance delta. We ASSERT the over-credit so the behavior is on record.
      await gauge.connect(alice).stake(1000n);

      const credited = await gauge.balanceOf(alice.address);
      const actuallyHeld = await stakeT.balanceOf(await gauge.getAddress());
      const fee = (1000n * FEE_BPS) / BPS;

      expect(credited).to.equal(1000n); // credited the full requested amount
      expect(actuallyHeld).to.equal(1000n - fee); // but received less
      // The discrepancy IS the over-credit:
      expect(credited).to.be.greaterThan(actuallyHeld);
      expect(credited - actuallyHeld).to.equal(fee);
    });

    it("FINDING consequence: the last withdrawer cannot get their full balance back (gauge is short)", async function () {
      const { gauge, alice, bob } = await loadFixture(fix);

      // Both stake the same nominal amount; the gauge is short by 2 fees in real tokens
      // while crediting both for the full nominal amount.
      await gauge.connect(alice).stake(1000n);
      await gauge.connect(bob).stake(1000n);

      // Alice withdraws her full credited balance first; her withdraw transfer ALSO skims a
      // fee on the way out, draining the shared pool further.
      await gauge.connect(alice).withdraw(1000n);

      // Bob is still credited 1000 but the gauge no longer holds 1000 real tokens for him.
      expect(await gauge.balanceOf(bob.address)).to.equal(1000n);
      // Bob's full withdraw reverts: the gauge's real balance is below his recorded balance.
      await expect(gauge.connect(bob).withdraw(1000n)).to.be.reverted;
    });
  });

  describe("LiquidityGauge with a rebasing stake token", function () {
    async function fix() {
      const [admin, dist, alice] = await ethers.getSigners();
      const Reb = await ethers.getContractFactory("RebasingToken");
      const stakeT = await Reb.deploy("RebLP", "RLP");

      const Mock = await ethers.getContractFactory("MockERC20");
      const rewardT = await Mock.deploy("Rew", "REW");

      const G = await ethers.getContractFactory("LiquidityGauge");
      const gauge = await G.deploy(
        await stakeT.getAddress(),
        await rewardT.getAddress(),
        dist.address
      );

      await stakeT.mint(alice.address, ethers.parseEther("1000"));
      await stakeT.connect(alice).approve(await gauge.getAddress(), ethers.MaxUint256);
      return { stakeT, gauge, alice };
    }

    it("FINDING: a downward rebase leaves the gauge holding fewer tokens than the staker's recorded balance", async function () {
      const { stakeT, gauge, alice } = await loadFixture(fix);
      const amount = ethers.parseEther("1000");
      await gauge.connect(alice).stake(amount);

      // The gauge recorded a fixed nominal `balanceOf`. A rebasing token's real holdings
      // float with the multiplier. Halve the multiplier (0.5x): the gauge's actual token
      // balance halves, but its recorded balanceOf[alice] is unchanged.
      await stakeT.rebase(ethers.parseEther("0.5"));

      const recorded = await gauge.balanceOf(alice.address);
      const realHeld = await stakeT.balanceOf(await gauge.getAddress());

      // FINDING (accounting drift): recorded stake (nominal) now exceeds real tokens held.
      expect(recorded).to.equal(amount);
      expect(realHeld).to.equal(amount / 2n);
      expect(recorded).to.be.greaterThan(realHeld);

      // Consequence: withdrawing the full recorded balance reverts — the tokens aren't there.
      await expect(gauge.connect(alice).withdraw(amount)).to.be.reverted;
      // The staker can only recover up to what the gauge really holds.
      await expect(gauge.connect(alice).withdraw(amount / 2n)).to.not.be.reverted;
    });

    it("an upward rebase strands the surplus (recorded balance under-counts real holdings)", async function () {
      const { stakeT, gauge, alice } = await loadFixture(fix);
      const amount = ethers.parseEther("1000");
      await gauge.connect(alice).stake(amount);

      // Double the multiplier: the gauge now holds 2x tokens but only credits `amount`.
      await stakeT.rebase(ethers.parseEther("2"));
      const recorded = await gauge.balanceOf(alice.address);
      const realHeld = await stakeT.balanceOf(await gauge.getAddress());

      expect(recorded).to.equal(amount);
      expect(realHeld).to.equal(amount * 2n);
      // The extra is stranded in the gauge — the staker can never withdraw it via balanceOf.
      expect(realHeld).to.be.greaterThan(recorded);
    });
  });
});
