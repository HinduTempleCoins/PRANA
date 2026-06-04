const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

// Full governance lifecycle: propose -> vote -> queue -> wait timelock -> execute.
// The governed action is a timelock-initiated mint of GovernanceToken to a beneficiary,
// so the proposal's effect is observable as an ERC-20 balance change.
describe("GovernorDAO", function () {
  // OZ GovernorCountingSimple: 0 = Against, 1 = For, 2 = Abstain.
  const VOTE_FOR = 1;
  const MIN_DELAY = 3600; // timelock minDelay (seconds)

  async function deployFixture() {
    const [admin, proposer, beneficiary] = await ethers.getSigners();

    // 1. Governance token (admin gets DEFAULT_ADMIN_ROLE + MINTER_ROLE).
    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy("Prana Governance", "gPRANA", admin.address);
    await token.waitForDeployment();

    // 2. Timelock: empty proposer/executor sets, admin as self-administrator for setup.
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(MIN_DELAY, [], [], admin.address);
    await timelock.waitForDeployment();

    // 3. Governor wired to token + timelock.
    const Governor = await ethers.getContractFactory("GovernorDAO");
    const governor = await Governor.deploy(
      await token.getAddress(),
      await timelock.getAddress()
    );
    await governor.waitForDeployment();

    // 4. Grant the governor the timelock PROPOSER_ROLE and EXECUTOR_ROLE.
    //    (executor = address(0) is the "open executor" convention; here we grant the
    //     governor explicitly, which is the tighter and recommended setup.)
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    await timelock.connect(admin).grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.connect(admin).grantRole(EXECUTOR_ROLE, await governor.getAddress());
    // Allow anyone to execute (executor = address(0)), exercising the open-role path too.
    await timelock.connect(admin).grantRole(EXECUTOR_ROLE, ethers.ZeroAddress);

    // 5. The timelock must be able to perform the governed action (minting). Give it
    //    MINTER_ROLE so an executed proposal can mint.
    const MINTER_ROLE = await token.MINTER_ROLE();
    await token.connect(admin).grantRole(MINTER_ROLE, await timelock.getAddress());

    // 6. Mint voting power to the proposer and self-delegate so getVotes > 0.
    const voteAmount = ethers.parseEther("1000");
    await token.connect(admin).mint(proposer.address, voteAmount);
    await token.connect(proposer).delegate(proposer.address);
    // Checkpoints update on the next block; mine one so votes are queryable at proposal time.
    await mine(1);

    return { admin, proposer, beneficiary, token, timelock, governor };
  }

  it("runs a full propose -> vote -> queue -> execute lifecycle", async function () {
    const { proposer, beneficiary, token, governor } = await deployFixture();

    expect(await governor.getVotes(proposer.address, (await ethers.provider.getBlockNumber()) - 1))
      .to.be.greaterThan(0n);

    // Build the proposal: have the timelock mint tokens to the beneficiary.
    const mintAmount = ethers.parseEther("42");
    const targets = [await token.getAddress()];
    const values = [0n];
    const calldatas = [
      token.interface.encodeFunctionData("mint", [beneficiary.address, mintAmount]),
    ];
    const description = "Mint 42 gPRANA to the beneficiary";
    const descriptionHash = ethers.id(description);

    expect(await token.balanceOf(beneficiary.address)).to.equal(0n);

    // --- propose ---
    const proposeTx = await governor
      .connect(proposer)
      .propose(targets, values, calldatas, description);
    await proposeTx.wait();
    const proposalId = await governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash
    );

    // Pending until votingDelay (1 block) elapses.
    expect(await governor.state(proposalId)).to.equal(0); // Pending
    await mine(2); // advance past the voting delay
    expect(await governor.state(proposalId)).to.equal(1); // Active

    // --- vote FOR ---
    await governor.connect(proposer).castVote(proposalId, VOTE_FOR);

    // Advance past the voting period (~50 blocks).
    await mine(51);
    expect(await governor.state(proposalId)).to.equal(4); // Succeeded

    // --- queue into the timelock ---
    await governor.queue(targets, values, calldatas, descriptionHash);
    expect(await governor.state(proposalId)).to.equal(5); // Queued

    // Advance time past the timelock minDelay so the operation is ready.
    await time.increase(MIN_DELAY + 1);

    // --- execute ---
    await governor.execute(targets, values, calldatas, descriptionHash);
    expect(await governor.state(proposalId)).to.equal(7); // Executed

    // --- assert the effect ---
    expect(await token.balanceOf(beneficiary.address)).to.equal(mintAmount);
  });
});
