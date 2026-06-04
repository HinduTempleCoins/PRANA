// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VeBoost} from "../lib/VeBoost.sol";

/// @notice Test-only wrapper exposing the internal {VeBoost} pure library for unit tests.
contract VeBoostHarness {
    function computeWorkingBalance(
        uint256 deposit,
        uint256 totalDeposits,
        uint256 userVe,
        uint256 totalVe
    ) external pure returns (uint256) {
        return VeBoost.computeWorkingBalance(deposit, totalDeposits, userVe, totalVe);
    }

    function boostMultiplier(
        uint256 deposit,
        uint256 totalDeposits,
        uint256 userVe,
        uint256 totalVe
    ) external pure returns (uint256) {
        return VeBoost.boostMultiplier(deposit, totalDeposits, userVe, totalVe);
    }
}
