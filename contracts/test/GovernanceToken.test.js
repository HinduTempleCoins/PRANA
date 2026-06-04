const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('GovernanceToken', function () {
  let token, admin, alice, bob;

  beforeEach(async function () {
    [admin, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('GovernanceToken');
    token = await Token.deploy('Governance Token', 'GOV', admin.address);
    await token.waitForDeployment();
  });

  it('starts at zero supply and mints under MINTER_ROLE', async function () {
    expect(await token.totalSupply()).to.equal(0n);
    await token.mint(alice.address, 1000n);
    expect(await token.balanceOf(alice.address)).to.equal(1000n);
    expect(await token.totalSupply()).to.equal(1000n);
  });

  it('reverts mint from an account without MINTER_ROLE', async function () {
    await expect(token.connect(alice).mint(alice.address, 1000n))
      .to.be.revertedWithCustomError(token, 'AccessControlUnauthorizedAccount');
  });

  it('activates voting power only after self-delegation', async function () {
    await token.mint(alice.address, 500n);
    // Holding tokens alone does not grant votes.
    expect(await token.getVotes(alice.address)).to.equal(0n);

    await token.connect(alice).delegate(alice.address);
    expect(await token.getVotes(alice.address)).to.equal(500n);
    expect(await token.delegates(alice.address)).to.equal(alice.address);
  });

  it('moves voting power on transfer after delegation', async function () {
    await token.mint(alice.address, 1000n);
    await token.connect(alice).delegate(alice.address);
    await token.connect(bob).delegate(bob.address);

    await token.connect(alice).transfer(bob.address, 400n);

    expect(await token.getVotes(alice.address)).to.equal(600n);
    expect(await token.getVotes(bob.address)).to.equal(400n);
  });

  it('exposes an EIP-712 permit domain and per-owner nonces', async function () {
    const domain = await token.eip712Domain();
    // fields bitmap, name, version, chainId, verifyingContract, salt, extensions
    expect(domain.name).to.equal('Governance Token');
    expect(domain.version).to.equal('1');
    expect(domain.verifyingContract).to.equal(await token.getAddress());
    expect(await token.nonces(alice.address)).to.equal(0n);
  });
});
