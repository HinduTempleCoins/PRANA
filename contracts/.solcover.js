module.exports = {
  // Mocks and vendored AMM (Uniswap V2 port) are excluded from coverage targets:
  // mocks are test scaffolding; amm/ is an unmodified pinned port covered upstream.
  skipFiles: [
    "mocks/",
    "amm/",
  ],
  // solidity-coverage instruments contracts; keep optimizer off for accurate line mapping (its default).
  configureYulOptimizer: true,
};
