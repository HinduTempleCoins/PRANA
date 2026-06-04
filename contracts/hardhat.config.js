require("@nomicfoundation/hardhat-toolbox");
// Coverage plugin — harmless to load unconditionally; only active under `hardhat coverage`.
try {
  require("solidity-coverage");
} catch (e) {
  /* dev-only --no-save package; ignore if absent */
}

/**
 * PRANA contracts — Hardhat config.
 * Solidity 0.8.24 (London-compatible; matches the local PoW chain's genesis forks).
 * The `prana_local` network points at the local core-geth dev node (chainId 108369).
 * No private keys are committed — supply one via the PRANA_DEPLOYER_KEY env var when deploying.
 */
const DEPLOYER = process.env.PRANA_DEPLOYER_KEY
  ? [process.env.PRANA_DEPLOYER_KEY]
  : [];

// Optional gas reporter — only loaded when REPORT_GAS is set, wrapped in try/catch
// so the config still loads if the (dev-only, --no-save) package is absent.
let GAS_REPORTER = { enabled: false };
if (process.env.REPORT_GAS) {
  try {
    require("hardhat-gas-reporter");
    GAS_REPORTER = {
      enabled: true,
      currency: "USD",
      noColors: true,
      excludeContracts: ["mocks/"],
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("REPORT_GAS set but hardhat-gas-reporter not installed:", e.message);
  }
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // London EVM keeps bytecode compatible with the local Ethash chain's fork set.
      evmVersion: "london",
    },
  },
  gasReporter: GAS_REPORTER,
  networks: {
    hardhat: {},
    prana_local: {
      url: process.env.PRANA_RPC || "http://127.0.0.1:8545",
      chainId: 108369,
      accounts: DEPLOYER,
    },
    // Alias used by chain/scripts/dev-stack.sh. Defaults to the publicly-known dev key #0
    // (genesis-prefunded in chain/genesis — DEV ONLY, never a real chain) so the live
    // bring-up can deploy without extra setup; override via PRANA_DEPLOYER_KEY.
    localprana: {
      url: process.env.PRANA_RPC || "http://127.0.0.1:8545",
      chainId: 108369,
      accounts: DEPLOYER.length
        ? DEPLOYER
        : ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
    },
  },
};
