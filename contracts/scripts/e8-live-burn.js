/**
 * e8-live-burn.js — E8 live acceptance: perform a REAL burn-to-mint on the running
 * PRANA PoW chain and capture tx hash + balances before/after.
 *
 * Reads contracts/deployments.json (written by deploy-core.js), mints the burnable input
 * to the deployer, approves the BurnMine, calls mine(amountIn), and prints:
 *   - input balance + supply before/after (must DROP by amountIn — a true burn)
 *   - PoL (output) balance before/after (must RISE by amountIn * ratioNum/ratioDen)
 *   - the mine() tx hash + block number
 *
 * Usage:  npx hardhat run scripts/e8-live-burn.js --network localprana
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "deployments.json"), "utf8")
  );
  const c = manifest.contracts;
  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();

  const input = await ethers.getContractAt("MockERC20", c.BurnInput);
  const pol = await ethers.getContractAt("PoLToken", c.PoLToken);
  const mine = await ethers.getContractAt("BurnMine", c.BurnMine);

  const ratioNum = await mine.ratioNum();
  const ratioDen = await mine.ratioDen();
  const amountIn = ethers.parseEther("100");
  const expectedOut = (amountIn * ratioNum) / ratioDen;

  console.log(`Network chainId: ${manifest.chainId}`);
  console.log(`BurnMine: ${c.BurnMine}  ratio ${ratioNum}:${ratioDen}`);
  console.log(`amountIn = ${ethers.formatEther(amountIn)}  expectedOut = ${ethers.formatEther(expectedOut)}\n`);

  // 1) mint input to ourselves so we have something to burn.
  console.log("==> minting BurnInput to deployer ...");
  await (await input.mint(me, amountIn)).wait();
  // 2) approve the mine to pull it.
  console.log("==> approving BurnMine ...");
  await (await input.approve(c.BurnMine, amountIn)).wait();

  // ---- BEFORE ----
  const inBalBefore = await input.balanceOf(me);
  const inSupplyBefore = await input.totalSupply();
  const polBalBefore = await pol.balanceOf(me);
  const totalBurnedBefore = await mine.totalBurned();
  const totalMintedBefore = await mine.totalMinted();

  // ---- the live burn-to-mint ----
  console.log("\n==> calling BurnMine.mine() on the LIVE PoW chain ...");
  const tx = await mine.mine(amountIn);
  const rcpt = await tx.wait();

  // ---- AFTER ----
  const inBalAfter = await input.balanceOf(me);
  const inSupplyAfter = await input.totalSupply();
  const polBalAfter = await pol.balanceOf(me);
  const totalBurnedAfter = await mine.totalBurned();
  const totalMintedAfter = await mine.totalMinted();

  const f = ethers.formatEther;
  console.log("\n================ E8 LIVE BURN-TO-MINT RESULT ================");
  console.log(`tx hash      : ${rcpt.hash}`);
  console.log(`block number : ${rcpt.blockNumber}`);
  console.log(`gas used     : ${rcpt.gasUsed}`);
  console.log("------------------------------------------------------------");
  console.log(`input balance   before: ${f(inBalBefore)}   after: ${f(inBalAfter)}`);
  console.log(`input supply    before: ${f(inSupplyBefore)}   after: ${f(inSupplyAfter)}  (burned: ${f(inSupplyBefore - inSupplyAfter)})`);
  console.log(`PoL  balance    before: ${f(polBalBefore)}   after: ${f(polBalAfter)}  (minted: ${f(polBalAfter - polBalBefore)})`);
  console.log(`mine.totalBurned before: ${f(totalBurnedBefore)}  after: ${f(totalBurnedAfter)}`);
  console.log(`mine.totalMinted before: ${f(totalMintedBefore)}  after: ${f(totalMintedAfter)}`);
  console.log("============================================================");

  // assertions
  const burned = inSupplyBefore - inSupplyAfter;
  const minted = polBalAfter - polBalBefore;
  const ok = burned === amountIn && minted === expectedOut && inBalAfter === inBalBefore - amountIn;
  console.log(ok ? "\nPASS: input truly burned and output minted at the fixed ratio." : "\nFAIL: conservation check did not hold.");
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
