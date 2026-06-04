// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title DAOTimelock — a thin, self-wiring wrapper over OpenZeppelin {TimelockController}.
/// @notice This is the execution layer a Governor queues passed proposals into: it enforces a
///         mandatory `minDelay` between scheduling and execution, giving the community a window to
///         react before a governance action takes effect. The wrapper bakes in the canonical
///         "Governor proposes, anyone executes, no standing admin" role layout so a deployer
///         cannot accidentally leave themselves a backdoor.
///
/// @dev ROLE WIRING (done entirely in the constructor — no post-deploy setup, no admin to renounce):
///        - PROPOSER_ROLE  + CANCELLER_ROLE → `governor` only. Only the Governor can schedule
///          (queue) and cancel operations.
///        - EXECUTOR_ROLE  → address(0), the OZ "open executor" sentinel: ANYONE may execute an
///          operation once its delay has elapsed. Execution is permissionless because the contents
///          were already fixed at schedule time; opening it removes a liveness dependency on the
///          Governor or a keeper.
///        - DEFAULT_ADMIN_ROLE (admin) → passed as address(0) to the base constructor, so NO
///          account ever holds admin. The base TimelockController briefly self-grants admin to
///          `address(this)` during construction (needed to set role admins) and the `admin`
///          parameter being zero means it never hands that role to an EOA. The timelock can still
///          be re-administered ONLY by itself, i.e. via a passed-and-executed governance proposal —
///          which is exactly the desired "the DAO governs the DAO's plumbing" property.
///
///      CONSTRUCTOR-SIGNATURE NOTE: this intentionally does NOT mirror the raw
///      `(minDelay, proposers[], executors[], admin)` signature of TimelockController. Existing
///      Governor tests that deploy a *raw* `TimelockController` keep working unchanged (this is an
///      additive contract). New deployments that want the opinionated wiring use this wrapper and
///      pass just `(minDelay, governor)`.
contract DAOTimelock is TimelockController {
    /// @notice The Governor wired in as the sole proposer/canceller at construction.
    address public immutable governor;

    error ZeroGovernor();

    /// @param minDelay  mandatory seconds between scheduling and execution of an operation.
    /// @param governor_ the Governor contract granted PROPOSER_ROLE + CANCELLER_ROLE; it is the
    ///                  only address allowed to queue or cancel timelock operations.
    constructor(uint256 minDelay, address governor_)
        TimelockController(
            minDelay,
            _singleton(governor_), // proposers = [governor]  (also gets CANCELLER_ROLE in base)
            _openExecutors(),      // executors = [address(0)] → open execution
            address(0)             // admin = 0 → no standing admin; only self-administration
        )
    {
        if (governor_ == address(0)) revert ZeroGovernor();
        governor = governor_;
    }

    /// @dev Build a one-element `[governor]` array for the base proposers list.
    function _singleton(address a) private pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    /// @dev Build a one-element `[address(0)]` array → the OZ "open executor" (anyone can execute).
    function _openExecutors() private pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = address(0);
    }

    // ------------------------------------------------------------------------------------------
    // Convenience views (thin wrappers over base state — purely for off-chain/UI ergonomics)
    // ------------------------------------------------------------------------------------------

    /// @notice True if `account` is allowed to schedule/cancel operations (PROPOSER == CANCELLER here).
    function isProposer(address account) external view returns (bool) {
        return hasRole(PROPOSER_ROLE, account);
    }

    /// @notice True if execution is open to everyone (the address(0) executor is granted).
    /// @dev Always true for this wrapper by construction, but exposed so integrators can assert it.
    function isExecutionOpen() external view returns (bool) {
        return hasRole(EXECUTOR_ROLE, address(0));
    }

    /// @notice True once operation `id` is ready to execute at-or-after `timestamp`.
    /// @dev Mirrors the base ready/timestamp logic without re-reading `block.timestamp`, so callers
    ///      can preview readiness for a hypothetical future time (e.g. a UI countdown). An operation
    ///      is ready iff it is scheduled (`getTimestamp > _DONE_TIMESTAMP`) and its eta has passed.
    function isOperationReadyAt(bytes32 id, uint256 timestamp) external view returns (bool) {
        uint256 eta = getTimestamp(id);
        // _DONE_TIMESTAMP == 1: 0 = unset, 1 = done, >1 = pending with that eta.
        return eta > 1 && timestamp >= eta;
    }
}
