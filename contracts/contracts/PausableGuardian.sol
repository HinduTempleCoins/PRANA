// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title PausableGuardian — guardian-gated pause with a timelocked unpause
/// @notice A small mixable module: a `GUARDIAN_ROLE` holder can pause immediately (a fast
///         circuit-breaker), but *unpausing* is a two-step, anti-fat-finger flow — the guardian
///         first `proposeUnpause()`, then after `unpauseDelay` seconds may `executeUnpause()`.
///         Inherit this and gate sensitive functions with `whenNotPaused`.
abstract contract PausableGuardian is AccessControl, Pausable {
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public immutable unpauseDelay;

    /// @dev Timestamp at/after which a proposed unpause may execute. 0 == no live proposal.
    uint256 public unpauseReadyAt;

    event UnpauseProposed(address indexed guardian, uint256 readyAt);
    event UnpauseCancelled(address indexed guardian);

    error UnpauseNotProposed();
    error UnpauseNotReady(uint256 readyAt);

    constructor(uint256 unpauseDelay_, address guardianAdmin) {
        _grantRole(DEFAULT_ADMIN_ROLE, guardianAdmin);
        _grantRole(GUARDIAN_ROLE, guardianAdmin);
        unpauseDelay = unpauseDelay_;
    }

    /// @notice Immediately pause. Clears any in-flight unpause proposal.
    /// @dev Callable while already paused so a guardian can kill a pending unpause
    ///      proposal with one call (OZ `_pause` itself reverts when already paused,
    ///      so it is only invoked on the not-paused → paused transition).
    function pause() external onlyRole(GUARDIAN_ROLE) {
        unpauseReadyAt = 0;
        if (!paused()) _pause();
    }

    /// @notice Start the timelock for unpausing. Must be paused.
    function proposeUnpause() external onlyRole(GUARDIAN_ROLE) whenPaused {
        unpauseReadyAt = block.timestamp + unpauseDelay;
        emit UnpauseProposed(msg.sender, unpauseReadyAt);
    }

    /// @notice Abort a pending unpause proposal (e.g. the threat returned).
    function cancelUnpause() external onlyRole(GUARDIAN_ROLE) {
        if (unpauseReadyAt == 0) revert UnpauseNotProposed();
        unpauseReadyAt = 0;
        emit UnpauseCancelled(msg.sender);
    }

    /// @notice Execute the unpause once the timelock has elapsed.
    function executeUnpause() external onlyRole(GUARDIAN_ROLE) whenPaused {
        if (unpauseReadyAt == 0) revert UnpauseNotProposed();
        if (block.timestamp < unpauseReadyAt) revert UnpauseNotReady(unpauseReadyAt);
        unpauseReadyAt = 0;
        _unpause();
    }
}
