const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EquityDividendToken", function () {
  let edt, currency, admin, alice, bob;

  const MAG = 2n ** 128n; // mirrors MAGNITUDE in the contract

  beforeEach(async () => {
    [admin, alice, bob] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    currency = await Mock.deploy("Dividend USD", "DUSD");

    const EDT = await ethers.getContractFactory("EquityDividendToken");
    edt = await EDT.deploy(
      "Equity Share",
      "A",
      await currency.getAddress(),
      admin.address
    );

    // Shares: alice 100, bob 300 (total 400).
    await edt.connect(admin).mint(alice.address, 100n);
    await edt.connect(admin).mint(bob.address, 300n);

    // Fund admin with dividend currency and approve the token to pull it.
    await currency.mint(admin.address, 1_000_000n);
    await currency.connect(admin).approve(await edt.getAddress(), 1_000_000n);
  });

  it("makes dividends withdrawable proportional to share balance", async () => {
    // 400 currency over 400 shares => exactly 1 per share.
    await edt.connect(admin).distributeDividends(400n);

    expect(await edt.withdrawableDividendOf(alice.address)).to.equal(100n);
    expect(await edt.withdrawableDividendOf(bob.address)).to.equal(300n);
  });

  it("increases magnifiedDividendPerShare by amount*MAGNITUDE/totalSupply", async () => {
    await edt.connect(admin).distributeDividends(800n); // 800/400 = 2 per share
    expect(await edt.magnifiedDividendPerShare()).to.equal((800n * MAG) / 400n);
    expect(await edt.withdrawableDividendOf(alice.address)).to.equal(200n);
    expect(await edt.withdrawableDividendOf(bob.address)).to.equal(600n);
  });

  it("shifts future dividends correctly when shares move between distributions", async () => {
    // First distribution under the original split (alice 100, bob 300).
    await edt.connect(admin).distributeDividends(400n); // 1 per share
    expect(await edt.withdrawableDividendOf(alice.address)).to.equal(100n);
    expect(await edt.withdrawableDividendOf(bob.address)).to.equal(300n);

    // Bob transfers 100 shares to Alice => alice 200, bob 200.
    await edt.connect(bob).transfer(alice.address, 100n);

    // Already-accrued dividends must be untouched by the transfer.
    expect(await edt.withdrawableDividendOf(alice.address)).to.equal(100n);
    expect(await edt.withdrawableDividendOf(bob.address)).to.equal(300n);

    // Second distribution now splits 200/200.
    await edt.connect(admin).distributeDividends(400n); // 1 per share
    expect(await edt.withdrawableDividendOf(alice.address)).to.equal(300n); // 100 + 200
    expect(await edt.withdrawableDividendOf(bob.address)).to.equal(500n); // 300 + 200
  });

  it("withdrawDividend transfers the currency and zeroes the withdrawable balance", async () => {
    await edt.connect(admin).distributeDividends(400n); // alice:100 bob:300

    await expect(edt.connect(alice).withdrawDividend())
      .to.emit(edt, "DividendWithdrawn")
      .withArgs(alice.address, 100n);

    expect(await currency.balanceOf(alice.address)).to.equal(100n);
    expect(await edt.withdrawableDividendOf(alice.address)).to.equal(0n);
    expect(await edt.withdrawnDividendOf(alice.address)).to.equal(100n);

    // A second withdrawal with nothing outstanding reverts.
    await expect(edt.connect(alice).withdrawDividend()).to.be.revertedWith(
      "EDT: nothing to withdraw"
    );
  });

  it("reverts when distributing with zero share supply", async () => {
    const EDT = await ethers.getContractFactory("EquityDividendToken");
    const empty = await EDT.deploy(
      "Empty Share",
      "E",
      await currency.getAddress(),
      admin.address
    );
    await currency.connect(admin).approve(await empty.getAddress(), 1000n);

    await expect(empty.connect(admin).distributeDividends(100n)).to.be.revertedWith(
      "EDT: no shares"
    );
  });

  it("restricts minting to MINTER_ROLE", async () => {
    await expect(
      edt.connect(alice).mint(alice.address, 1n)
    ).to.be.revertedWithCustomError(edt, "AccessControlUnauthorizedAccount");
  });
});
