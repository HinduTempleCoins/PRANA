const { ethers } = require("hardhat");

// Deploys the PoL token, a demo input token, and a 10:1 burn mine, then wires the
// mine's minter authority on PoL. Run against the local PRANA chain:
//   PRANA_DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network prana_local
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const PoL = await ethers.getContractFactory("PoLToken");
  const pol = await PoL.deploy(deployer.address);
  await pol.waitForDeployment();
  console.log("PoLToken :", await pol.getAddress());

  const Mock = await ethers.getContractFactory("MockERC20");
  const input = await Mock.deploy("Demo Input", "DIN");
  await input.waitForDeployment();
  console.log("Input    :", await input.getAddress());

  const Mine = await ethers.getContractFactory("BurnMine");
  const mine = await Mine.deploy(
    await input.getAddress(),
    await pol.getAddress(),
    1,  // ratioNum
    10  // ratioDen  ->  10 input burned mints 1 POL
  );
  await mine.waitForDeployment();
  console.log("BurnMine :", await mine.getAddress());

  const MINTER = await pol.MINTER_ROLE();
  await (await pol.grantRole(MINTER, await mine.getAddress())).wait();
  console.log("Granted MINTER_ROLE on PoL -> BurnMine. Ready.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
