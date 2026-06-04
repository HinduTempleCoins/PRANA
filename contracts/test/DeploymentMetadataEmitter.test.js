const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DeploymentMetadataEmitter", function () {
  let emitter, recorder, other;
  const deployed = "0x1111111111111111111111111111111111111111";
  const sourceId = ethers.id("some-standard-json-build");
  const ctorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "uint256"],
    ["Tok", "TOK", 1000n]
  );

  beforeEach(async () => {
    [recorder, other] = await ethers.getSigners();
    const E = await ethers.getContractFactory("DeploymentMetadataEmitter");
    emitter = await E.deploy();
  });

  it("records a deployment and emits DeploymentMetadata with the right shape", async () => {
    await expect(emitter.connect(recorder).recordDeployment(deployed, sourceId, ctorArgs))
      .to.emit(emitter, "DeploymentMetadata")
      .withArgs(deployed, sourceId, ctorArgs, recorder.address);
    expect(await emitter.recorded(deployed)).to.equal(true);
  });

  it("is permissionless (any caller can record a different address)", async () => {
    const other2 = "0x2222222222222222222222222222222222222222";
    await expect(emitter.connect(other).recordDeployment(other2, sourceId, "0x"))
      .to.emit(emitter, "DeploymentMetadata")
      .withArgs(other2, sourceId, "0x", other.address);
  });

  it("rejects the zero address", async () => {
    await expect(
      emitter.recordDeployment(ethers.ZeroAddress, sourceId, ctorArgs)
    ).to.be.revertedWithCustomError(emitter, "ZeroDeployment");
  });

  it("is first-write-wins: a rewrite reverts", async () => {
    await emitter.recordDeployment(deployed, sourceId, ctorArgs);
    await expect(emitter.recordDeployment(deployed, sourceId, ctorArgs))
      .to.be.revertedWithCustomError(emitter, "AlreadyRecorded")
      .withArgs(deployed);
    // even a different recorder / different metadata cannot overwrite
    await expect(
      emitter.connect(other).recordDeployment(deployed, ethers.id("other"), "0x")
    ).to.be.revertedWithCustomError(emitter, "AlreadyRecorded");
  });
});
