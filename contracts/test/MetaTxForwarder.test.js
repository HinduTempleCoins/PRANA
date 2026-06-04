const { expect } = require("chai");
const { ethers } = require("hardhat");

// EIP-712 type for ERC2771Forwarder.ForwardRequest (must match OZ's typehash exactly,
// minus the `signature` field which is not part of the signed struct).
const FORWARD_REQUEST_TYPE = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

describe("MetaTxForwarder (ERC-2771 gasless meta-tx)", function () {
  let forwarder, recipient, relayer, signer, domain;
  let forwarderAddr, recipientAddr;

  // Build a fully-signed ForwardRequestData for recipient.ping() from `from`.
  async function buildRequest(from, overrides = {}) {
    const nonce = await forwarder.nonces(from.address);
    const block = await ethers.provider.getBlock("latest");
    const pingData = recipient.interface.encodeFunctionData("ping");

    const req = {
      from: from.address,
      to: recipientAddr,
      value: 0n,
      gas: 200000n,
      nonce,
      deadline: BigInt(block.timestamp + 3600),
      data: pingData,
      ...overrides,
    };

    const signature = await from.signTypedData(domain, FORWARD_REQUEST_TYPE, {
      from: req.from,
      to: req.to,
      value: req.value,
      gas: req.gas,
      nonce: req.nonce,
      deadline: req.deadline,
      data: req.data,
    });

    // ForwardRequestData has no `nonce` field (forwarder reads it on-chain).
    return {
      from: req.from,
      to: req.to,
      value: req.value,
      gas: req.gas,
      deadline: req.deadline,
      data: req.data,
      signature,
    };
  }

  beforeEach(async () => {
    [relayer, signer] = await ethers.getSigners();

    const Forwarder = await ethers.getContractFactory("MetaTxForwarder");
    forwarder = await Forwarder.deploy();
    forwarderAddr = await forwarder.getAddress();

    const Recipient = await ethers.getContractFactory("RecipientMock");
    recipient = await Recipient.deploy(forwarderAddr);
    recipientAddr = await recipient.getAddress();

    const { chainId } = await ethers.provider.getNetwork();
    domain = {
      name: "MetaTxForwarder",
      version: "1",
      chainId,
      verifyingContract: forwarderAddr,
    };
  });

  it("executes a meta-tx and records the ORIGINAL signer as the caller", async () => {
    const reqData = await buildRequest(signer);

    // Relayer (not the signer) pays gas and submits the request.
    await forwarder.connect(relayer).execute(reqData);

    expect(await recipient.lastCaller()).to.equal(signer.address);
    expect(await recipient.lastCaller()).to.not.equal(forwarderAddr);
    // Nonce consumed.
    expect(await forwarder.nonces(signer.address)).to.equal(1n);
  });

  it("verify() returns true for a valid request", async () => {
    const reqData = await buildRequest(signer);
    expect(await forwarder.verify(reqData)).to.equal(true);
  });

  it("reverts on a tampered request (data altered after signing)", async () => {
    const reqData = await buildRequest(signer);
    // Tamper: point the call at a different selector after the signature was produced.
    const tampered = { ...reqData, data: "0xdeadbeef" };

    expect(await forwarder.verify(tampered)).to.equal(false);
    await expect(forwarder.connect(relayer).execute(tampered))
      .to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderInvalidSigner");
  });

  it("reverts on an expired request", async () => {
    const block = await ethers.provider.getBlock("latest");
    const expired = await buildRequest(signer, {
      deadline: BigInt(block.timestamp - 1),
    });

    expect(await forwarder.verify(expired)).to.equal(false);
    await expect(forwarder.connect(relayer).execute(expired))
      .to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderExpiredRequest");
  });

  it("reverts when a request is replayed (nonce already used)", async () => {
    const reqData = await buildRequest(signer);
    await forwarder.connect(relayer).execute(reqData);

    // Same signed payload again: on-chain nonce moved on, so the signer no longer matches.
    await expect(forwarder.connect(relayer).execute(reqData))
      .to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderInvalidSigner");
  });
});
