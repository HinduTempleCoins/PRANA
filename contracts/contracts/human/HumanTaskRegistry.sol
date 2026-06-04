// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IHumanTaskRegistry} from "../interfaces/IHumanTaskRegistry.sol";

/// @title HumanTaskRegistry (AG1) — the DAO-governed catalog of HUMAN task-types.
/// @notice The human mirror of {TaskRegistry}. Where TaskRegistry catalogs AI/scientific compute
///         tasks for the TASK lane, this catalogs the HUMAN data-work that trains the models —
///         preference ranking (RLHF), supervised demonstrations (SFT), red-team / eval, annotation,
///         surveys, focus groups, expert elicitation, curation. Each entry carries a spec hash, a
///         {Kind}, the {IHumanContributionGate} that verifies it, a TASK-lane share-weight, a minimum
///         reputation tier gating access, a two-buyer flag (the same verified contribution can serve
///         BOTH AI-training and market-research buyers), and an enabled flag. Consumers:
///           * contributors / off-chain UX read {taskType} to learn what to do and how it's checked;
///           * {HumanContributionGate} is named per task as the verification policy;
///           * {HumanTaskCreditor} reads {shareWeight} + {minReputation} to weight & gate credit.
///
/// @dev GOVERNANCE: every mutation is gated by `GOVERNOR_ROLE` (the DAO timelock in prod). Holds no
///      token and moves no value — pure governed configuration, exactly like {TaskRegistry}.
/// @dev LANE CHOICE (UD-AG-A): human work routes through the EXISTING `Lane.TASK` of the unified
///      pool (no new HUMAN ledger lane is added). The {shareWeight} here is the TASK-lane multiplier
///      applied when crediting. Whether human work should instead get its OWN ledger lane is a user
///      decision (UD-AG-A) deferred to governance; this catalog works either way.
contract HumanTaskRegistry is AccessControl, IHumanTaskRegistry {
    /// @notice Role permitted to register/update/enable/disable human task-types (the DAO timelock).
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @dev taskId → its catalog entry. Unregistered ids read as the zero-struct (enabled=false).
    mapping(bytes32 => TaskType) private _taskTypes;

    /// @dev Enumeration support so off-chain UX / dispatch can list the catalog.
    bytes32[] private _taskIds;
    mapping(bytes32 => bool) private _known;

    error ZeroTaskId();
    error ZeroVerificationGate();
    error ZeroShareWeight();
    error UnknownTask(bytes32 taskId);

    /// @notice Emitted when a task-type's enabled flag is flipped without a full re-set.
    event HumanTaskTypeEnabled(bytes32 indexed taskId, bool enabled);

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

    /// @notice Register or update a human task-type. Idempotent on `taskId` (overwrites the entry).
    /// @param taskId            the catalog key (e.g. keccak256("rlhf-preference-v1")).
    /// @param specHash          off-chain task spec hash.
    /// @param kind              the flavor of human work (see {Kind}).
    /// @param verificationGate  the {IHumanContributionGate} that verifies completions (nonzero).
    /// @param shareWeight       TASK-lane weight, 1e18 = equal-to-hash (nonzero — disable via flag).
    /// @param minReputation     minimum reputation TIER required to be credited for this task.
    /// @param twoBuyer          serves BOTH AI-training and market-research buyers.
    /// @param enabled           whether the task-type is currently routable / creditable.
    function setTaskType(
        bytes32 taskId,
        bytes32 specHash,
        Kind kind,
        address verificationGate,
        uint256 shareWeight,
        uint256 minReputation,
        bool twoBuyer,
        bool enabled
    ) external onlyRole(GOVERNOR_ROLE) {
        if (taskId == bytes32(0)) revert ZeroTaskId();
        if (verificationGate == address(0)) revert ZeroVerificationGate();
        // shareWeight must be nonzero so the creditor's weight guard is never the way a task is
        // "turned off" — disabling is an explicit `enabled=false`, not a 0-weight footgun.
        if (shareWeight == 0) revert ZeroShareWeight();

        _taskTypes[taskId] = TaskType({
            specHash: specHash,
            kind: kind,
            verificationGate: verificationGate,
            shareWeight: shareWeight,
            minReputation: minReputation,
            twoBuyer: twoBuyer,
            enabled: enabled
        });

        if (!_known[taskId]) {
            _known[taskId] = true;
            _taskIds.push(taskId);
        }

        emit HumanTaskTypeSet(taskId, specHash, kind, verificationGate, shareWeight, minReputation, twoBuyer, enabled);
    }

    /// @notice Flip a known task-type's enabled flag without re-supplying its full config.
    function setEnabled(bytes32 taskId, bool enabled) external onlyRole(GOVERNOR_ROLE) {
        if (!_known[taskId]) revert UnknownTask(taskId);
        _taskTypes[taskId].enabled = enabled;
        emit HumanTaskTypeEnabled(taskId, enabled);
        TaskType storage t = _taskTypes[taskId];
        emit HumanTaskTypeSet(
            taskId, t.specHash, t.kind, t.verificationGate, t.shareWeight, t.minReputation, t.twoBuyer, enabled
        );
    }

    // ------------------------------------------------------------------------------------------
    // IHumanTaskRegistry reads (the integration surface the human stack uses)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IHumanTaskRegistry
    function taskType(bytes32 taskId) external view returns (TaskType memory) {
        return _taskTypes[taskId];
    }

    /// @inheritdoc IHumanTaskRegistry
    function isEnabled(bytes32 taskId) external view returns (bool) {
        return _taskTypes[taskId].enabled;
    }

    /// @inheritdoc IHumanTaskRegistry
    function shareWeight(bytes32 taskId) external view returns (uint256) {
        return _taskTypes[taskId].shareWeight;
    }

    /// @inheritdoc IHumanTaskRegistry
    function minReputation(bytes32 taskId) external view returns (uint256) {
        return _taskTypes[taskId].minReputation;
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

    /// @notice Convenience: whether a task-type serves both AI-training and market-research buyers.
    function isTwoBuyer(bytes32 taskId) external view returns (bool) {
        return _taskTypes[taskId].twoBuyer;
    }
}
