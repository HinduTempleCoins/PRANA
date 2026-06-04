const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const UNPAUSE_DELAY = 3600;
const CONSUMER_KEY = ethers.keccak256(ethers.toUtf8Bytes("PolygonLink"));
const DST = 137n;
const SRC = 137n;
const DOMAIN = "PRANA.MessagingBridgeAdapter.v1";

// Rebuild the envelope exactly as the contract does (must match for inbound replay/decoding).
function buildEnvelope(consumerKey, originChainId, dstChainId, nonce, payload) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [DOMAIN, consumerKey, originChainId, dstChainId, nonce, payload]
  );
}

describe("MessagingBridgeAdapter (BI5 — generic swappable-transport messaging adapter)", function () {
  async function deployFixture() {
    const [admin, consumer, outsider] = await ethers.getSigners();

    const Transport = await ethers.getContractFactory("MockMessageTransport");
    const transport = await Transport.deploy();

    const Adapter = await ethers.getContractFactory("MessagingBridgeAdapter");
    const adapter = await Adapter.deploy(UNPAUSE_DELAY, admin.address, await transport.getAddress());

    const Consumer = await ethers.getContractFactory("MockMessageConsumer");
    const dstConsumer = await Consumer.deploy();

    // Grant the EOA `consumer` the CONSUMER_ROLE so it can call sendMessage directly in tests.
    await adapter.connect(admin).grantConsumer(consumer.address);
    // Register the inbound dispatch target for CONSUMER_KEY.
    await adapter.connect(admin).setInboundConsumer(CONSUMER_KEY, await dstConsumer.getAddress());

    return { adapter, transport, dstConsumer, admin, consumer, outsider };
  }

  it("deploys with transport set and admin roles", async () => {
    const { adapter, transport, admin } = await loadFixture(deployFixture);
    expect(await adapter.transport()).to.equal(await transport.getAddress());
    expect(await adapter.hasRole(await adapter.GUARDIAN_ROLE(), admin.address)).to.equal(true);
  });

  it("admin can swap the transport (UD-BI-A is a runtime choice)", async () => {
    const { adapter, admin, outsider } = await loadFixture(deployFixture);
    const Transport = await ethers.getContractFactory("MockMessageTransport");
    const t2 = await Transport.deploy();
    await expect(adapter.connect(admin).setTransport(await t2.getAddress()))
      .to.emit(adapter, "TransportSet")
      .withArgs(await t2.getAddress());
    await expect(adapter.connect(outsider).setTransport(await t2.getAddress())).to.be.reverted;
  });

  describe("outbound sendMessage", function () {
    it("only a CONSUMER_ROLE holder may send; wraps + hands to transport", async () => {
      const { adapter, transport, consumer, outsider } = await loadFixture(deployFixture);
      const payload = ethers.toUtf8Bytes("hello-polygon");

      await expect(
        adapter.connect(outsider).sendMessage(CONSUMER_KEY, DST, payload)
      ).to.be.reverted;

      await expect(adapter.connect(consumer).sendMessage(CONSUMER_KEY, DST, payload))
        .to.emit(adapter, "MessageSent");

      expect(await transport.sendCount()).to.equal(1n);
      expect(await transport.lastDstChainId()).to.equal(DST);
      expect(await adapter.outboundNonce(CONSUMER_KEY)).to.equal(1n);
    });

    it("forwards msg.value as the transport fee", async () => {
      const { adapter, transport, consumer } = await loadFixture(deployFixture);
      await transport.setFee(1000n);
      const payload = ethers.toUtf8Bytes("paid");
      await adapter.connect(consumer).sendMessage(CONSUMER_KEY, DST, payload, { value: 1000n });
      expect(await transport.lastValueReceived()).to.equal(1000n);
    });

    it("quoteSend reflects the transport fee", async () => {
      const { adapter, transport, consumer } = await loadFixture(deployFixture);
      await transport.setFee(4242n);
      const payload = ethers.toUtf8Bytes("q");
      expect(await adapter.quoteSend(CONSUMER_KEY, DST, payload)).to.equal(4242n);
    });
  });

  describe("inbound receiveMessage", function () {
    it("validates via transport, then dispatches the inner payload to the consumer", async () => {
      const { adapter, dstConsumer } = await loadFixture(deployFixture);
      const payload = ethers.toUtf8Bytes("inbound-payload");
      const envelope = buildEnvelope(CONSUMER_KEY, SRC, SRC, 0n, payload);

      await expect(adapter.receiveMessage(SRC, envelope, "0x"))
        .to.emit(adapter, "MessageReceived");

      expect(await dstConsumer.callCount()).to.equal(1n);
      expect(await dstConsumer.lastSrcChainId()).to.equal(SRC);
      expect(await dstConsumer.lastPayload()).to.equal(ethers.hexlify(payload));
    });

    it("reverts when the transport reports the inbound as unproven", async () => {
      const { adapter, transport } = await loadFixture(deployFixture);
      await transport.setInboundValid(false);
      const envelope = buildEnvelope(CONSUMER_KEY, SRC, SRC, 0n, ethers.toUtf8Bytes("x"));
      await expect(adapter.receiveMessage(SRC, envelope, "0x")).to.be.revertedWithCustomError(
        adapter,
        "InboundNotProven"
      );
    });

    it("replay protection: the same envelope cannot be delivered twice", async () => {
      const { adapter } = await loadFixture(deployFixture);
      const envelope = buildEnvelope(CONSUMER_KEY, SRC, SRC, 0n, ethers.toUtf8Bytes("once"));
      const envelopeHash = ethers.keccak256(envelope);
      await adapter.receiveMessage(SRC, envelope, "0x");
      expect(await adapter.consumedEnvelope(envelopeHash)).to.equal(true);
      await expect(adapter.receiveMessage(SRC, envelope, "0x")).to.be.revertedWithCustomError(
        adapter,
        "EnvelopeAlreadyConsumed"
      );
    });

    it("reverts on an unknown consumer key", async () => {
      const { adapter } = await loadFixture(deployFixture);
      const badKey = ethers.keccak256(ethers.toUtf8Bytes("UnregisteredApp"));
      const envelope = buildEnvelope(badKey, SRC, SRC, 0n, ethers.toUtf8Bytes("y"));
      await expect(adapter.receiveMessage(SRC, envelope, "0x")).to.be.revertedWithCustomError(
        adapter,
        "UnknownConsumer"
      );
    });

    it("reverts on a tampered domain tag (BadEnvelope)", async () => {
      const { adapter } = await loadFixture(deployFixture);
      const envelope = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "uint256", "uint256", "bytes"],
        ["WRONG.DOMAIN", CONSUMER_KEY, SRC, SRC, 0n, ethers.toUtf8Bytes("z")]
      );
      await expect(adapter.receiveMessage(SRC, envelope, "0x")).to.be.revertedWithCustomError(
        adapter,
        "BadEnvelope"
      );
    });

    it("respects pause", async () => {
      const { adapter, admin } = await loadFixture(deployFixture);
      await adapter.connect(admin).pause();
      const envelope = buildEnvelope(CONSUMER_KEY, SRC, SRC, 0n, ethers.toUtf8Bytes("p"));
      await expect(adapter.receiveMessage(SRC, envelope, "0x")).to.be.revertedWithCustomError(
        adapter,
        "EnforcedPause"
      );
    });
  });

  it("round-trip: send produces an envelope that receive can dispatch", async () => {
    const { adapter, transport, dstConsumer, consumer } = await loadFixture(deployFixture);
    const payload = ethers.toUtf8Bytes("round-trip");
    await adapter.connect(consumer).sendMessage(CONSUMER_KEY, DST, payload);
    const envelope = await transport.lastPayload();
    // Deliver the exact envelope the transport carried.
    await adapter.receiveMessage(SRC, envelope, "0x");
    expect(await dstConsumer.lastPayload()).to.equal(ethers.hexlify(payload));
  });
});
