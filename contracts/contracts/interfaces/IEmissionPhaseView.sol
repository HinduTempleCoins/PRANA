// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IEmissionPhaseView — minimal read surface for "what emission epoch are we in".
/// @notice EmissionScheduler-compatible. The fee oracle reads `currentEpoch()` so the curve can
///         taper out of the bootstrap regime by phase as well as by machine-count threshold X.
interface IEmissionPhaseView {
    /// @return The current emission epoch index.
    function currentEpoch() external view returns (uint64);
}
