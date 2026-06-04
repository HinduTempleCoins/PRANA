// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title EpochManager — shared epoch math for the unified shares ledger, its lane creditors,
///        and the settlement fee hook, so every compute-stack contract agrees on epoch boundaries.
/// @dev Pure/stateless library. Epochs are fixed-width timestamp buckets; the PPLNS window is a
///      fixed number of trailing epochs. All compute-stack contracts that need an epoch number
///      MUST derive it through here (never inline `block.timestamp / X`) so boundaries never drift.
library EpochManager {
    error ZeroEpochLength();

    /// @notice The epoch index a timestamp falls into.
    function epochAt(uint256 timestamp, uint256 epochLength) internal pure returns (uint256) {
        if (epochLength == 0) revert ZeroEpochLength();
        return timestamp / epochLength;
    }

    /// @notice The current epoch index (by block.timestamp).
    function currentEpoch(uint256 epochLength) internal view returns (uint256) {
        return epochAt(block.timestamp, epochLength);
    }

    /// @notice Inclusive [start,end] epoch bounds of the PPLNS window ending at `epoch`.
    /// @dev window of W epochs ending at `epoch` → [epoch-W+1, epoch], clamped at 0.
    function windowBounds(uint256 epoch, uint256 windowEpochs)
        internal
        pure
        returns (uint256 startEpoch, uint256 endEpoch)
    {
        endEpoch = epoch;
        startEpoch = windowEpochs == 0 || windowEpochs > epoch + 1 ? 0 : epoch - windowEpochs + 1;
    }

    /// @notice Unix timestamp at which `epoch` begins.
    function epochStart(uint256 epoch, uint256 epochLength) internal pure returns (uint256) {
        return epoch * epochLength;
    }

    /// @notice True once `epoch` is fully in the past (claimable / settleable).
    function isEpochClosed(uint256 epoch, uint256 epochLength) internal view returns (bool) {
        return block.timestamp >= (epoch + 1) * epochLength;
    }
}
