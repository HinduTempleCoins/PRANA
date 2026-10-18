// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ICoordinatorRegistry — read surface of the permissionless coordinator allowlist (PR1).
/// @notice The narrow view/guard surface the TASK-lane creditor consults so a TASK share can only
///         be settled by a bonded, active, unslashed coordinator. This is the composition point
///         that turns the "anyone may run a pool" property from architecturally-staged (bond exists
///         but is not checked at credit time) into enforced (a coordinator's slashable bond is a
///         precondition of crediting useful-work shares). See CoordinatorRegistry.sol for the full
///         bond / cooldown / slash accounting; the creditor never moves a bond, it only reads state.
interface ICoordinatorRegistry {
    /// @notice True iff `coordinator` is registered, active, unslashed and bonded >= current minBond.
    function isActiveCoordinator(address coordinator) external view returns (bool);

    /// @notice Reverting form of {isActiveCoordinator} (NotActiveCoordinator) for inline guarding.
    function requireActiveCoordinator(address coordinator) external view;
}
