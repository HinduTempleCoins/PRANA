// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITaskRegistry} from "../interfaces/ITaskRegistry.sol";

/// @title TaskRegistry (backlog RR1) — the DAO-governed catalog of AI task-types.
/// @notice The Bittensor-subnet analog: the DAO (that IS the reward pool) registers WHICH AI/
///         scientific task-types may earn pooled value, each with a spec hash, a verification gate,
///         a TASK-lane share weight, a dispatch priority, and an enabled flag. Consumers:
///           * workers read {taskType} to learn what to run and how it's verified;
///           * {TaskLaneCreditor} reads {shareWeight} to weight verified completions into the pool;
///           * {TaskDispatchPolicy} reads {priority} (+ enabled) to rank/route work.
///
/// @dev GOVERNANCE: every mutation is gated by `GOVERNOR_ROLE`, intended to be held by the DAO
///      timelock (and optionally a bootstrap admin during progressive decentralization). This
///      contract holds no token and moves no value — it is pure governed configuration. The
///      ITaskRegistry views (`taskType`/`isEnabled`/`shareWeight`) are the read surface the rest of
///      the compute stack already integrates against (see {TaskLaneCreditor}).
contract TaskRegistry is AccessControl, ITaskRegistry {
    /// @notice Role permitted to register/update/enable/disable task-types (the DAO timelock).
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @dev taskId → its catalog entry. Unregistered ids read as the zero-struct (enabled=false).
    mapping(bytes32 => TaskType) private _taskTypes;

    /// @dev Enumeration support so off-chain workers / dispatch can list the catalog.
    bytes32[] private _taskIds;
    mapping(bytes32 => bool) private _known;

    error ZeroTaskId();
    error ZeroVerificationGate();
    error ZeroShareWeight();
    error UnknownTask(bytes32 taskId);

    /// @notice Emitted when a task-type's enabled flag is flipped without a full re-set.
    event TaskTypeEnabled(bytes32 indexed taskId, bool enabled);

    /// @param admin the bootstrap admin (DEFAULT_ADMIN_ROLE + GOVERNOR_ROLE); hand GOVERNOR_ROLE to
    ///        the DAO timelock and renounce the bootstrap role to complete decentralization.
    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------
    // Governed mutations
    // ------------------------------------------------------------------------------------------

    /// @notice Register or update a task-type. Idempotent on `taskId` (overwrites the entry).
    /// @param taskId            the catalog key (e.g. keccak256("hathor-inference")).
    /// @param specHash          off-chain task spec hash.
    /// @param verificationGate  the {ITaskVerificationGate} that verifies completions (nonzero).
    /// @param shareWeight       TASK-lane weight, 1e18 = equal-to-hash (nonzero — disable via flag).
    /// @param priority          dispatch priority (higher = preferred); read by {TaskDispatchPolicy}.
    /// @param enabled           whether the task-type is currently routable/creditable.
    function setTaskType(
        bytes32 taskId,
        bytes32 specHash,
        address verificationGate,
        uint256 shareWeight,
        uint256 priority,
        bool enabled
    ) external onlyRole(GOVERNOR_ROLE) {
        if (taskId == bytes32(0)) revert ZeroTaskId();
        if (verificationGate == address(0)) revert ZeroVerificationGate();
        // shareWeight must be nonzero so {TaskLaneCreditor}'s ZeroWeight guard is never the way a
        // task is "turned off" — disabling is an explicit `enabled=false`, not a 0-weight footgun.
        if (shareWeight == 0) revert ZeroShareWeight();

        _taskTypes[taskId] = TaskType({
            specHash: specHash,
            verificationGate: verificationGate,
            shareWeight: shareWeight,
            priority: priority,
            enabled: enabled
        });

        if (!_known[taskId]) {
            _known[taskId] = true;
            _taskIds.push(taskId);
        }

        emit TaskTypeSet(taskId, specHash, verificationGate, shareWeight, priority, enabled);
    }

    /// @notice Flip a known task-type's enabled flag without re-supplying its full config.
    function setEnabled(bytes32 taskId, bool enabled) external onlyRole(GOVERNOR_ROLE) {
        if (!_known[taskId]) revert UnknownTask(taskId);
        _taskTypes[taskId].enabled = enabled;
        emit TaskTypeEnabled(taskId, enabled);
        TaskType storage t = _taskTypes[taskId];
        emit TaskTypeSet(taskId, t.specHash, t.verificationGate, t.shareWeight, t.priority, enabled);
    }

    // ------------------------------------------------------------------------------------------
    // ITaskRegistry reads (the integration surface the compute stack already uses)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ITaskRegistry
    function taskType(bytes32 taskId) external view returns (TaskType memory) {
        return _taskTypes[taskId];
    }

    /// @inheritdoc ITaskRegistry
    function isEnabled(bytes32 taskId) external view returns (bool) {
        return _taskTypes[taskId].enabled;
    }

    /// @inheritdoc ITaskRegistry
    function shareWeight(bytes32 taskId) external view returns (uint256) {
        return _taskTypes[taskId].shareWeight;
    }

    // ------------------------------------------------------------------------------------------
    // Enumeration (for dispatch / off-chain listing)
    // ------------------------------------------------------------------------------------------

    /// @notice Whether `taskId` has ever been registered (entry exists, regardless of enabled).
    function isKnown(bytes32 taskId) external view returns (bool) {
        return _known[taskId];
    }

    /// @notice Number of registered task-types (enabled or not).
    function taskCount() external view returns (uint256) {
        return _taskIds.length;
    }

    /// @notice The task-type id at catalog index `i`.
    function taskIdAt(uint256 i) external view returns (bytes32) {
        return _taskIds[i];
    }

    /// @notice The full list of registered task-type ids (enabled or not).
    function allTaskIds() external view returns (bytes32[] memory) {
        return _taskIds;
    }

    /// @notice Convenience: the governed dispatch priority of a task-type.
    function priorityOf(bytes32 taskId) external view returns (uint256) {
        return _taskTypes[taskId].priority;
    }
}
