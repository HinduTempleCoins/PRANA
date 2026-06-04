const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

// Commit a draw, advance past the reveal block, then reveal. Returns the winner.
async function runDraw(lotto, caller, salt) {
  const saltHash = await lotto.saltHashOf(salt);
  await lotto.connect(caller).commitDraw(saltHash);
  await mine(2); // advance past commitBlock+1 so blockhash(commitBlock+1) exists
  return lotto.connect(caller).revealDraw(salt);
}

describe("NoLossLotto", function () {
  let token, lotto, admin, u1, u2, sponsor, stranger;
  const SALT = ethers.id("draw-salt-1");

  beforeEach(async () => {
    [admin, u1, u2, sponsor, stranger] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Save", "SAV");
    const L = await ethers.getContractFactory("NoLossLotto");
    lotto = await L.deploy(await token.getAddress(), admin.address);

    for (const [who, amt] of [[u1, 300n], [u2, 100n], [sponsor, 50n]]) {
      await token.mint(who.address, amt);
      await token.connect(who).approve(await lotto.getAddress(), amt);
    }
    await lotto.connect(u1).deposit(300n);
    await lotto.connect(u2).deposit(100n);
    await lotto.connect(sponsor).addPrize(50n);
  });

  it("pays only the prize, never principal; principal stays withdrawable", async () => {
    await runDraw(lotto, admin, SALT);
    expect(await lotto.prizePool()).to.equal(0n);

    // exactly one of the depositors won the prize-only payout
    const w1 = await token.balanceOf(u1.address);
    const w2 = await token.balanceOf(u2.address);
    expect(w1 + w2).to.equal(50n); // prize only, no principal touched

    // principal still fully withdrawable for both
    await lotto.connect(u1).withdraw(300n);
    await lotto.connect(u2).withdraw(100n);
    expect(await token.balanceOf(u1.address)).to.equal(w1 + 300n);
    expect(await token.balanceOf(u2.address)).to.equal(w2 + 100n);
  });

  it("SECURITY: the caller cannot force a win by choosing the seed", async () => {
    // The old draw(seed) let any caller pick the winner. Now the winner is fixed by a future
    // blockhash committed-to before it is known, so the caller cannot steer it.
    // Sanity: an attacker cannot even call the draw functions without the role.
    const saltHash = await lotto.saltHashOf(SALT);
    await expect(
      lotto.connect(stranger).commitDraw(saltHash)
    ).to.be.revertedWithCustomError(lotto, "AccessControlUnauthorizedAccount");

    // Even the authorized admin cannot pick the winner: the seed is derived from
    // blockhash(commitBlock+1), unknowable at commit time. A reveal with the wrong salt fails,
    // so the committer cannot swap in a salt chosen after seeing the blockhash.
    await lotto.connect(admin).commitDraw(saltHash);
    await mine(2);
    await expect(
      lotto.connect(admin).revealDraw(ethers.id("different-salt"))
    ).to.be.revertedWithCustomError(lotto, "BadSalt");

    // The honest reveal still works and the winner is one of the real depositors.
    const tx = await lotto.connect(admin).revealDraw(SALT);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => lotto.interface.parseLog(l)).find((l) => l && l.name === "Winner");
    expect([u1.address, u2.address]).to.include(ev.args.winner);
  });

  it("rejects reveal before the reveal block (TooEarly) and an empty draw", async () => {
    const saltHash = await lotto.saltHashOf(SALT);
    await lotto.connect(admin).commitDraw(saltHash);
    // blockhash(commitBlock+1) not yet available
    await expect(
      lotto.connect(admin).revealDraw(SALT)
    ).to.be.revertedWithCustomError(lotto, "TooEarly");
  });

  it("cannot commit a draw with no prize", async () => {
    await runDraw(lotto, admin, SALT); // drains the prize
    const saltHash = await lotto.saltHashOf(ethers.id("again"));
    await expect(
      lotto.connect(admin).commitDraw(saltHash)
    ).to.be.revertedWithCustomError(lotto, "NothingToDraw");
  });

  it("only one open draw at a time", async () => {
    const saltHash = await lotto.saltHashOf(SALT);
    await lotto.connect(admin).commitDraw(saltHash);
    await expect(
      lotto.connect(admin).commitDraw(saltHash)
    ).to.be.revertedWithCustomError(lotto, "CommitOpen");
  });
});
