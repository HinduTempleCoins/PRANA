// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUnifiedSharesLedger} from "./IUnifiedSharesLedger.sol";

/// @title IHashTaskWeightConfig — the DAO-governed per-lane weight + vardiff bounds surface.
/// @notice The UnifiedSharesLedger reads `laneWeight(lane)` to pool a lane's native shares into the
///         common per-epoch pool: pooled = amount * laneWeight / 1e18. HASH and TASK default to 1e18
///         each ("seamless switching" — a hashed share and a tasked share are worth the same). The
///         BURN lane weight and the vardiff (min/max difficulty) bounds the off-chain coordinator
///         reads are all DAO-settable. The exact final ratio is a user/governance decision; the
///         contract only enforces 1:1 as the default.
interface IHashTaskWeightConfig {
    event LaneWeightSet(IUnifiedSharesLedger.Lane indexed lane, uint256 weight);
    event VardiffBoundsSet(uint256 minDifficulty, uint256 maxDifficulty);

    /// @notice Pooling weight (1e18 = 1x) applied to a lane's native shares before they enter the pool.
    function laneWeight(IUnifiedSharesLedger.Lane lane) external view returns (uint256);

    /// @notice Vardiff floor/ceiling the off-chain HASH-lane coordinator clamps per-worker difficulty to.
    function minDifficulty() external view returns (uint256);
    function maxDifficulty() external view returns (uint256);
}
