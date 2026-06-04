const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("CommitRevealRaffle (commit-reveal future-blockhash draw)", function () {
  let token, raffle, owner, a, b, c;
  const PRICE = 100n;
  const DELAY = 5n;

  beforeEach(async () => {
    [owner, a, b, c] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Raffle", "RAF");

    const Raffle = await ethers.getContractFactory("CommitRevealRaffle");
    raffle = await Raffle.deploy(await token.getAddress(), PRICE, DELAY);

    const raffleAddr = await raffle.getAddress();
    for (const who of [a, b, c]) {
      await token.mint(who.address, 10_000n);
      await token.connect(who).approve(raffleAddr, 10_000n);
    }
  });

  it("buying tickets accrues the prize pool and assigns ticket numbers", async () => {
    await raffle.connect(a).buyTicket(3n);
    await raffle.connect(b).buyTicket(2n);

    expect(await raffle.ticketCount()).to.equal(5n);
    expect(await raffle.prizePool()).to.equal(5n * PRICE);
    expect(await token.balanceOf(await raffle.getAddress())).to.equal(5n * PRICE);

    // a holds tickets 0,1,2 ; b holds 3,4
    expect(await raffle.ticketOwner(0)).to.equal(a.address);
    expect(await raffle.ticketOwner(2)).to.equal(a.address);
    expect(await raffle.ticketOwner(3)).to.equal(b.address);
    expect(await raffle.ticketOwner(4)).to.equal(b.address);
  });

  it("reverts buying after entries are closed", async () => {
    await raffle.connect(a).buyTicket(1n);
    await raffle.connect(owner).closeEntries();
    await expect(raffle.connect(b).buyTicket(1n)).to.be.revertedWithCustomError(
      raffle,
      "EntriesAreClosed"
    );
  });

  it("reverts draw() before the draw block is reached", async () => {
    await raffle.connect(a).buyTicket(2n);
    await raffle.connect(b).buyTicket(2n);
    await raffle.connect(owner).closeEntries();

    // drawBlock = close block + DELAY; we are well before it
    await expect(raffle.draw()).to.be.revertedWithCustomError(raffle, "TooEarly");
  });

  it("after mining past drawBlock, draw() picks a valid ticket holder and pays the pool", async () => {
    await raffle.connect(a).buyTicket(3n);
    await raffle.connect(b).buyTicket(2n);
    await raffle.connect(c).buyTicket(5n); // 10 tickets total, pool = 1000

    const pool = await raffle.prizePool();
    expect(pool).to.equal(10n * PRICE);

    await raffle.connect(owner).closeEntries();
    const drawBlock = await raffle.drawBlock();

    // mine until we are strictly past drawBlock and its hash is available
    await mine(DELAY + 1n);

    const balBefore = {
      [a.address]: await token.balanceOf(a.address),
      [b.address]: await token.balanceOf(b.address),
      [c.address]: await token.balanceOf(c.address),
    };

    await expect(raffle.draw()).to.emit(raffle, "Drawn");

    expect(await raffle.drawn()).to.equal(true);
    expect(await raffle.prizePool()).to.equal(0n);
    expect(await token.balanceOf(await raffle.getAddress())).to.equal(0n);

    // exactly one of the three holders received the full pool
    const gained = await Promise.all(
      [a, b, c].map(async (w) => (await token.balanceOf(w.address)) - balBefore[w.address])
    );
    const winners = gained.filter((g) => g === pool);
    const others = gained.filter((g) => g === 0n);
    expect(winners.length).to.equal(1);
    expect(others.length).to.equal(2);

    // drawBlock was a real, fixed future block
    expect(drawBlock).to.be.greaterThan(0n);
  });

  it("the drawn winning ticket is within the valid ticket range and held by the paid winner", async () => {
    await raffle.connect(a).buyTicket(4n);
    await raffle.connect(b).buyTicket(6n); // 10 tickets
    const total = await raffle.ticketCount();

    await raffle.connect(owner).closeEntries();
    await mine(DELAY + 1n);

    const tx = await raffle.draw();
    const receipt = await tx.wait();

    // decode the Drawn event
    const parsed = receipt.logs
      .map((l) => {
        try {
          return raffle.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "Drawn");

    expect(parsed).to.not.equal(undefined);
    const winningTicket = parsed.args.winningTicket;
    const winner = parsed.args.winner;

    expect(winningTicket).to.be.greaterThanOrEqual(0n);
    expect(winningTicket).to.be.lessThan(total);
    // the winner is the recorded owner of the winning ticket
    expect(await raffle.ticketOwner(winningTicket)).to.equal(winner);
  });

  it("double draw reverts (AlreadyDrawn)", async () => {
    await raffle.connect(a).buyTicket(2n);
    await raffle.connect(owner).closeEntries();
    await mine(DELAY + 1n);

    await raffle.draw();
    await expect(raffle.draw()).to.be.revertedWithCustomError(raffle, "AlreadyDrawn");
  });
});
