/**
 * faucet.js — local dev faucet (backlog N10).
 *
 * Sends native PRANA (and optionally every deployed ERC-20 with a faucet-friendly
 * mint or balance) from the funded dev account to a list of test addresses.
 *
 * Usage:
 *   npx hardhat run scripts/faucet.js --network localprana   # uses RECIPIENTS below or env
 *   FAUCET_TO=0xabc...,0xdef... FAUCET_PRANA=5 npx hardhat run scripts/faucet.js --network localprana
 */
const hre = require("hardhat");
const { loadRegistry } = require("./lib/deployments");

const RECIPIENTS = (process.env.FAUCET_TO || "").split(",").filter(Boolean);
const PRANA_EACH = hre.ethers.parseEther(process.env.FAUCET_PRANA || "10");

async function main() {
  const [dev] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (RECIPIENTS.length === 0) {
    console.log("No recipients. Set FAUCET_TO=0x...,0x...");
    return;
  }
  console.log(`Faucet from ${dev.address} on chainId ${net.chainId}`);

  // 1. Native PRANA.
  for (const to of RECIPIENTS) {
    const tx = await dev.sendTransaction({ to, value: PRANA_EACH });
    await tx.wait();
    console.log(`  ${hre.ethers.formatEther(PRANA_EACH)} PRANA -> ${to}  (${tx.hash})`);
  }

  // 2. Any registered demo tokens we can mint (PoLToken-style role-gated mint held by dev).
  const reg = loadRegistry();
  const chain = reg[String(net.chainId)];
  if (chain && chain.contracts) {
    for (const [name, rec] of Object.entries(chain.contracts)) {
      try {
        const c = await hre.ethers.getContractAt(
          ["function mint(address,uint256)", "function decimals() view returns (uint8)"],
          rec.address,
          dev
        );
        const dec = await c.decimals().catch(() => 18n);
        for (const to of RECIPIENTS) {
          await (await c.mint(to, 100n * 10n ** BigInt(dec))).wait();
        }
        console.log(`  minted 100 ${name} to each recipient`);
      } catch {
        /* not mintable by dev — skip silently */
      }
    }
  }
  console.log("Faucet done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
