const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Sign a Permit2Lite PermitTransferFrom with EIP-712.
async function signPermit(permit2, owner, permit) {
  const net = await ethers.provider.getNetwork();
  const domain = {
    name: "Permit2Lite",
    version: "1",
    chainId: net.chainId,
    verifyingContract: await permit2.getAddress(),
  };
  const types = {
    PermitTransferFrom: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "spender", type: "address" },
    ],
  };
  return owner.signTypedData(domain, types, permit);
}

describe("Permit2Lite (Permit2-shaped SignatureTransfer)", function () {
  async function deployFixture() {
    const [deployer, owner, spender, attacker] = await ethers.getSigners();

    const P2 = await ethers.getContractFactory("Permit2Lite");
    const permit2 = await P2.deploy();
    await permit2.waitForDeployment();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Mock", "MK");
    await token.waitForDeployment();
    await token.mint(owner.address, ethers.parseEther("100"));

    // owner approves Permit2Lite once.
    await token
      .connect(owner)
      .approve(await permit2.getAddress(), ethers.MaxUint256);

    return { permit2, token, deployer, owner, spender, attacker };
  }

  function buildPermit(token, amount, nonce, deadline, spender) {
    return { token, amount, nonce, deadline, spender };
  }

  it("pulls tokens to the spender on a valid signature", async function () {
    const { permit2, token, owner, spender } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("10");
    const deadline = (await time.latest()) + 3600;
    const permit = buildPermit(
      await token.getAddress(),
      amount,
      1n,
      deadline,
      spender.address
    );
    const sig = await signPermit(permit2, owner, permit);

    await expect(
      permit2.connect(spender).permitTransferFrom(permit, owner.address, amount, sig)
    )
      .to.emit(permit2, "NonceInvalidated")
      .withArgs(owner.address, 1n);

    expect(await token.balanceOf(spender.address)).to.equal(amount);
    expect(await permit2.isNonceUsed(owner.address, 1n)).to.equal(true);
  });

  it("reverts when a nonce is reused", async function () {
    const { permit2, token, owner, spender } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("5");
    const deadline = (await time.latest()) + 3600;
    const permit = buildPermit(
      await token.getAddress(),
      amount,
      42n,
      deadline,
      spender.address
    );
    const sig = await signPermit(permit2, owner, permit);

    await permit2.connect(spender).permitTransferFrom(permit, owner.address, amount, sig);
    await expect(
      permit2.connect(spender).permitTransferFrom(permit, owner.address, amount, sig)
    ).to.be.revertedWithCustomError(permit2, "InvalidNonce");
  });

  it("reverts past the deadline", async function () {
    const { permit2, token, owner, spender } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    const deadline = (await time.latest()) + 100;
    const permit = buildPermit(
      await token.getAddress(),
      amount,
      7n,
      deadline,
      spender.address
    );
    const sig = await signPermit(permit2, owner, permit);

    await time.increase(200);
    await expect(
      permit2.connect(spender).permitTransferFrom(permit, owner.address, amount, sig)
    ).to.be.revertedWithCustomError(permit2, "SignatureExpired");
  });

  it("reverts on a forged signature (wrong signer)", async function () {
    const { permit2, token, owner, spender, attacker } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    const deadline = (await time.latest()) + 3600;
    const permit = buildPermit(
      await token.getAddress(),
      amount,
      9n,
      deadline,
      spender.address
    );
    const sig = await signPermit(permit2, attacker, permit);

    await expect(
      permit2.connect(spender).permitTransferFrom(permit, owner.address, amount, sig)
    ).to.be.revertedWithCustomError(permit2, "InvalidSigner");
  });

  it("reverts when requested exceeds the permitted amount", async function () {
    const { permit2, token, owner, spender } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    const deadline = (await time.latest()) + 3600;
    const permit = buildPermit(
      await token.getAddress(),
      amount,
      11n,
      deadline,
      spender.address
    );
    const sig = await signPermit(permit2, owner, permit);

    await expect(
      permit2
        .connect(spender)
        .permitTransferFrom(permit, owner.address, amount + 1n, sig)
    ).to.be.revertedWithCustomError(permit2, "AmountExceedsPermitted");
  });

  describe("DepositWithPermit2Example (e2e)", function () {
    async function deployExampleFixture() {
      const base = await deployFixture();
      const Vault = await ethers.getContractFactory("DepositWithPermit2Example");
      const vault = await Vault.deploy(await base.permit2.getAddress());
      await vault.waitForDeployment();
      return { ...base, vault };
    }

    it("deposits via permit and lets the depositor withdraw", async function () {
      const { permit2, token, owner, vault } = await loadFixture(deployExampleFixture);
      const amount = ethers.parseEther("20");
      const deadline = (await time.latest()) + 3600;
      // spender MUST be the vault so pulled tokens land there.
      const permit = buildPermit(
        await token.getAddress(),
        amount,
        100n,
        deadline,
        await vault.getAddress()
      );
      const sig = await signPermit(permit2, owner, permit);

      await expect(
        vault.connect(owner).depositWithPermit(permit, owner.address, amount, sig)
      )
        .to.emit(vault, "Deposited")
        .withArgs(owner.address, await token.getAddress(), amount);

      expect(await vault.deposits(owner.address)).to.equal(amount);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(amount);

      // Withdraw back.
      await expect(vault.connect(owner).withdraw(await token.getAddress(), amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(owner.address, await token.getAddress(), amount);
      expect(await vault.deposits(owner.address)).to.equal(0n);
    });

    it("reverts withdraw beyond the deposited balance", async function () {
      const { token, owner, vault } = await loadFixture(deployExampleFixture);
      await expect(
        vault.connect(owner).withdraw(await token.getAddress(), 1n)
      ).to.be.revertedWithCustomError(vault, "InsufficientDeposit");
    });
  });
});
