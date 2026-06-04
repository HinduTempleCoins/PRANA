// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PausableGuardian} from "../PausableGuardian.sol";

/// @notice Test-only demo showing how to integrate PausableGuardian: a trivial counter "vault"
///         whose state-changing entrypoint is gated by `whenNotPaused`.
contract DemoPausableVault is PausableGuardian {
    uint256 public value;

    constructor(uint256 unpauseDelay_, address guardianAdmin)
        PausableGuardian(unpauseDelay_, guardianAdmin)
    {}

    /// @notice A protected action that is blocked while paused.
    function bump() external whenNotPaused {
        value += 1;
    }
}
