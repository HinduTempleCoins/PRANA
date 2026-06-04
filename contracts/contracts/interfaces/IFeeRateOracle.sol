// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IFeeRateOracle — read-only protocol-fee rate surface (the Hathor rate).
/// @notice The settlement fee hook reads the CURRENT fee rate (in basis points) from this
///         surface at every settlement. The rate is a pure, rules-based FUNCTION of on-chain
///         inputs (PRANA price, emission phase, sustained verified-machine count). There is
///         deliberately NO setter on the output — Hathor (and everyone) is read-only here; only
///         the underlying curve PARAMETERS are governable, and they are bounded by a floor/ceiling.
interface IFeeRateOracle {
    /// @notice The fee rate to apply right now, in basis points (1e4 = 100%).
    /// @dev MUST be within [floorBps, ceilingBps]. Deterministic given current on-chain state.
    function currentRateBps() external view returns (uint16);
}
