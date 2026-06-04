// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVerifiedMachineCounter} from "../interfaces/IVerifiedMachineCounter.sol";

/// @notice Test-only verified-machine counter: lets tests drive `sustainedCount()` directly to
///         exercise the threshold-X step in CountercyclicalFeeOracle without simulating heartbeats.
contract MockVerifiedCounter is IVerifiedMachineCounter {
    uint256 public count;

    function setCount(uint256 c) external {
        count = c;
    }

    function sustainedCount() external view returns (uint256) {
        return count;
    }
}
