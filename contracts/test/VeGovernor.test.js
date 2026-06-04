const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

// Full governance lifecycle with VE-WEIGHTED voting power:
//   lock in VoteEscrow -> checkpoint into VeVotesAdapter -> propose -> vote (with the decayed-at-
//   snapshot weight) -> queue into DAOTimelock -> wait -> execute.
// The governed action is a timelock-initiated mint of a GovernanceToken, observable as a balance.
//
// VE TIMING NOTE: VoteEscrow weight decays per SECOND. Hardhat advances ~1s per mined block, so
// over a ~55-block proposal lifecycle the weight of a long lock (maxLock >> elapsed seconds) barely
// moves — it stays comfortably above quorum. The "expired voter" case uses a SHORT lock and jumps
// time past its end before checkpointing, so its snapshot records ~0.
describe("VeGovernor (ve-weighted voting)", function () {
  const VOTE_FOR = 1;
  const VOTE_AGAINST = 0;
  const MIN_DELAY = 3600; // timelock minDelay (seconds)
  const MAX_LOCK = 4 * 365 * 24 * 3600; // 4 years in seconds (Curve-style)

  async function deployFixture() {
    const [admin, whale, shrimp, expired, beneficiary] = await ethers.getSigners();

    // Lock token (plain ERC-20) that backs VoteEscrow.
    const Mock = await ethers.getContractFactory("MockERC20");
    const lockToken = await Mock.deploy("Lock", "LOCK");
    await lockToken.waitForDeployment();

    // VoteEscrow over the lock token.
    const VE = await ethers.getContractFactory("VoteEscrow");
    const escrow = await VE.deploy(await lockToken.getAddress(), MAX_LOCK);
    await escrow.waitForDeployment();

    // IVotes adapter (checkpoints ve weight by block number).
    const Adapter = await ethers.getContractFactory("VeVotesAdapter");
    const adapter = await Adapter.deploy(await escrow.getAddress());
    await adapter.waitForDeployment();

    // Governance token to be minted by an executed proposal (the governed effect).
    const GovToken = await ethers.getContractFactory("GovernanceToken");
    const govToken = await GovToken.deploy("Prana Governance", "gPRANA", admin.address);
    await govToken.waitForDeployment();

    // DAOTimelock wired to the governor (set below); we deploy the governor first to get its
    // address, but DAOTimelock needs the governor address at construction. Deploy timelock with a
    // placeholder governor would break wiring, so: deploy governor pointing at a timelock, but the
    // governor needs the timelock address too. Resolve the cycle by precomputing the governor
    // address from the deployer nonce.
    const govNonce = (await ethers.provider.getTransactionCount(admin.address)) + 1; // +1: timelock deploy is next, governor after
    const predictedGovernor = ethers.getCreateAddress({ from: admin.address, nonce: govNonce });

    const Timelock = await ethers.getContractFactory("DAOTimelock");
    const timelock = await Timelock.deploy(MIN_DELAY, predictedGovernor);
    await timelock.waitForDeployment();

    const Governor = await ethers.getContractFactory("VeGovernor");
    const governor = await Governor.deploy(
      await adapter.getAddress(),
      await timelock.getAddress()
    );
    await governor.waitForDeployment();

    // Sanity: the timelock's proposer must be the actual governor we deployed.
    expect(await governor.getAddress()).to.equal(predictedGovernor);
    expect(await timelock.governor()).to.equal(await governor.getAddress());

    // The timelock must be able to mint the governance token when a proposal executes.
    const MINTER_ROLE = await govToken.MINTER_ROLE();
    await govToken.connect(admin).grantRole(MINTER_ROLE, await timelock.getAddress());

    // Fund lockers with lock token and approve the escrow.
    for (const acct of [whale, shrimp, expired]) {
      await lockToken.mint(acct.address, ethers.parseEther("10000"));
      await lockToken.connect(acct).approve(await escrow.getAddress(), ethers.MaxUint256);
    }

    return {
      admin, whale, shrimp, expired, beneficiary,
      lockToken, escrow, adapter, govToken, timelock, governor,
    };
  }

  it("runs lock -> checkpoint -> propose -> ve-weighted vote -> queue -> execute", async function () {
    const { whale, shrimp, beneficiary, escrow, adapter, govToken, governor } = await deployFixture();

    // Whale locks big for the full term; shrimp locks small. ve weight ~ amount * timeLeft/maxLock,
    // so a full-term lock retains nearly its full amount as weight.
    await escrow.connect(whale).lock(ethers.parseEther("9000"), MAX_LOCK);
    await escrow.connect(shrimp).lock(ethers.parseEther("100"), MAX_LOCK);

    // Checkpoint both into the adapter so their weight is recorded at a block the Governor can read.
    await adapter.connect(whale).checkpoint();
    await adapter.connect(shrimp).checkpoint();
    await mine(1); // ensure the checkpoint block is strictly in the past for getPastVotes

    const bn = (await ethers.provider.getBlockNumber()) - 1;
    const whaleVotes = await governor.getVotes(whale.address, bn);
    const shrimpVotes = await governor.getVotes(shrimp.address, bn);
    expect(whaleVotes).to.be.greaterThan(0n);
    expect(shrimpVotes).to.be.greaterThan(0n);
    // Whale weight dwarfs shrimp (~9000 vs ~100 of full-term weight).
    expect(whaleVotes).to.be.greaterThan(shrimpVotes * 50n);

    // Build the proposal: timelock mints 42 gPRANA to the beneficiary.
    const mintAmount = ethers.parseEther("42");
    const targets = [await govToken.getAddress()];
    const values = [0n];
    const calldatas = [
      govToken.interface.encodeFunctionData("mint", [beneficiary.address, mintAmount]),
    ];
    const description = "VE: mint 42 gPRANA to the beneficiary";
    const descriptionHash = ethers.id(description);

    expect(await govToken.balanceOf(beneficiary.address)).to.equal(0n);

    // --- propose (whale has weight > proposalThreshold = 0) ---
    await governor.connect(whale).propose(targets, values, calldatas, description);
    const proposalId = await governor.hashProposal(targets, values, calldatas, descriptionHash);

    expect(await governor.state(proposalId)).to.equal(0); // Pending
    await mine(2); // past votingDelay
    expect(await governor.state(proposalId)).to.equal(1); // Active

    // The vote weight used is read at the proposal SNAPSHOT block.
    const snapshot = await governor.proposalSnapshot(proposalId);
    const whaleAtSnapshot = await governor.getVotes(whale.address, snapshot);
    expect(whaleAtSnapshot).to.be.greaterThan(0n);

    // --- vote FOR with whale weight; shrimp votes AGAINST (loses) ---
    await governor.connect(whale).castVote(proposalId, VOTE_FOR);
    await governor.connect(shrimp).castVote(proposalId, VOTE_AGAINST);

    await mine(51); // past votingPeriod
    expect(await governor.state(proposalId)).to.equal(4); // Succeeded (For >> Against, quorum met)

    // --- queue into the DAOTimelock ---
    await governor.queue(targets, values, calldatas, descriptionHash);
    expect(await governor.state(proposalId)).to.equal(5); // Queued

    await time.increase(MIN_DELAY + 1);

    // --- execute (open execution: anyone) ---
    await governor.execute(targets, values, calldatas, descriptionHash);
    expect(await governor.state(proposalId)).to.equal(7); // Executed

    expect(await govToken.balanceOf(beneficiary.address)).to.equal(mintAmount);
  });

  it("an expired lock checkpoints to ~0 weight at a later snapshot", async function () {
    const { expired, escrow, adapter, governor } = await deployFixture();

    // Short lock that will expire soon.
    const shortDur = 1000; // seconds
    await escrow.connect(expired).lock(ethers.parseEther("5000"), shortDur);

    // While active, the live ve weight is non-zero.
    expect(await escrow.balanceOf(expired.address)).to.be.greaterThan(0n);

    // Jump well past expiry, THEN checkpoint — the snapshot must record 0.
    await time.increase(shortDur + 10);
    await adapter.connect(expired).checkpoint();
    await mine(1);

    expect(await escrow.balanceOf(expired.address)).to.equal(0n);
    const bn = (await ethers.provider.getBlockNumber()) - 1;
    expect(await governor.getVotes(expired.address, bn)).to.equal(0n);
  });

  it("quorum is computed against the checkpointed total ve weight", async function () {
    const { whale, escrow, adapter, governor } = await deployFixture();

    // No locks/checkpoints yet → past total supply is 0 → quorum is 0 at that block.
    await mine(2);
    const earlyBlock = (await ethers.provider.getBlockNumber()) - 1;
    expect(await adapter.getPastTotalSupply(earlyBlock)).to.equal(0n);
    expect(await governor.quorum(earlyBlock)).to.equal(0n);

    // Whale locks and checkpoints; the adapter's checkpointed total now reflects whale weight.
    await escrow.connect(whale).lock(ethers.parseEther("1000"), MAX_LOCK);
    await adapter.connect(whale).checkpoint();
    await mine(1);

    const lateBlock = (await ethers.provider.getBlockNumber()) - 1;
    const total = await adapter.getPastTotalSupply(lateBlock);
    expect(total).to.be.greaterThan(0n);

    // Governor quorum = 4% of the checkpointed total at that block.
    const q = await governor.quorum(lateBlock);
    expect(q).to.equal((total * 4n) / 100n);
  });
});
