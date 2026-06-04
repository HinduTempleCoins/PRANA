/**
 * deploy-core.js — deploy a curated DeFi-core set to PRANA (or any EVM target)
 * and record the addresses to contracts/deployments.json.
 *
 * Curated set + wiring (constructor args verified against the .sol sources):
 *   - PoLToken(deployer)                          Proof-of-Liquidity reward token (mintable)
 *   - ERC20Base("Demo","DEMO",1e27,deployer)      generic capped/permit token template (demo)
 *   - WrappedNative()                             WPRANA (WETH9-style native wrapper)
 *   - MockERC20("Burn Input","BURNIN")            burnable input token for the burn-mine demo
 *   - BurnMine(MockERC20, PoLToken, 10, 1)        burn 1 input -> mint 10 PoL (1:10)
 *       * grant PoLToken MINTER_ROLE to BurnMine so it can mint its output
 *   - DividendDistributor(PoLToken, PoLToken)     stake PoL, earn PoL fees (demo: same token)
 *   - VoteEscrow(PoLToken, 31536000)              ve-lock PoL, maxLock = 1 year
 *   - GaugeController(VoteEscrow)                 ve-weighted emission direction
 *
 * EmissionScheduler is intentionally skipped: its safe cap/halving parameters are
 * project-policy decisions, not a sensible hard-coded default for a generic deploy.
 *
 * Robust by design: each deploy is wrapped in try/catch so one failure does not abort
 * the rest; every address is logged; deployments.json is written at the end regardless.
 *
 * Usage:  npx hardhat run scripts/deploy-core.js --network <name>
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log("");

  // name -> address, filled in as we go.
  const contracts = {};

  /**
   * Deploy one contract by artifact name, log + record its address.
   * Returns the contract instance, or null on failure (errors are caught).
   */
  async function deploy(label, factoryName, args = []) {
    try {
      const Factory = await ethers.getContractFactory(factoryName);
      const c = await Factory.deploy(...args);
      await c.waitForDeployment();
      const addr = await c.getAddress();
      contracts[label] = addr;
      console.log(`  ${label.padEnd(20)} ${addr}`);
      return c;
    } catch (err) {
      console.error(`  ${label.padEnd(20)} FAILED: ${err.message || err}`);
      return null;
    }
  }

  console.log("Deploying core set:");

  // 1) Proof-of-Liquidity reward token. Deployer gets admin + minter roles.
  const pol = await deploy("PoLToken", "PoLToken", [deployerAddr]);

  // 2) Generic demo ERC-20 from the template: capped at 1e27, deployer is admin.
  const demoCap = 10n ** 27n;
  await deploy("DemoToken", "ERC20Base", ["Demo", "DEMO", demoCap, deployerAddr]);

  // 3) Wrapped native coin (WPRANA). No constructor args.
  await deploy("WrappedNative", "WrappedNative", []);

  // 4) Burnable input token for the burn-mine demo (mocks/MockERC20.sol).
  const burnInput = await deploy("BurnInput", "MockERC20", ["Burn Input", "BURNIN"]);

  // 5) Burn-mine: burn 1 BurnInput -> mint 10 PoL (ratioNum=10, ratioDen=1).
  let burnMine = null;
  if (pol && burnInput) {
    const inputAddr = await burnInput.getAddress();
    const outputAddr = await pol.getAddress();
    burnMine = await deploy("BurnMine", "BurnMine", [inputAddr, outputAddr, 10, 1]);

    // Wire: grant the burn-mine PoL MINTER_ROLE so it can mint its output.
    if (burnMine) {
      try {
        const MINTER_ROLE = await pol.MINTER_ROLE();
        const tx = await pol.grantRole(MINTER_ROLE, await burnMine.getAddress());
        await tx.wait();
        console.log(`  -> granted PoL MINTER_ROLE to BurnMine`);
      } catch (err) {
        console.error(`  -> grant MINTER_ROLE FAILED: ${err.message || err}`);
      }
    }
  } else {
    console.error("  BurnMine            SKIPPED: needs PoLToken + BurnInput");
  }

  // 6) Dividend distributor: stake PoL, earn PoL-denominated fees (demo: same token).
  if (pol) {
    const polAddr = await pol.getAddress();
    await deploy("DividendDistributor", "DividendDistributor", [polAddr, polAddr]);
  } else {
    console.error("  DividendDistributor SKIPPED: needs PoLToken");
  }

  // 7) Vote-escrow lock on PoL, maxLock = 1 year (31536000 s).
  let ve = null;
  if (pol) {
    const polAddr = await pol.getAddress();
    ve = await deploy("VoteEscrow", "VoteEscrow", [polAddr, 31536000]);
  } else {
    console.error("  VoteEscrow          SKIPPED: needs PoLToken");
  }

  // 8) Gauge controller over the ve-lock.
  if (ve) {
    const veAddr = await ve.getAddress();
    await deploy("GaugeController", "GaugeController", [veAddr]);
  } else {
    console.error("  GaugeController     SKIPPED: needs VoteEscrow");
  }

  // EmissionScheduler intentionally skipped (cap/halving policy not a generic default).

  // Persist the deployment manifest.
  const manifest = {
    network: network.name,
    chainId,
    timestamp: new Date().toISOString(),
    contracts,
  };
  const outPath = path.resolve(__dirname, "..", "deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log("");
  console.log(
    `Deployed ${Object.keys(contracts).length} contracts. ` +
      `Wrote ${path.relative(path.resolve(__dirname, ".."), outPath)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
