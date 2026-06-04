// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ITaskRegistry — DAO-governed catalog of AI task-types (the Bittensor-subnet analog).
/// @notice The DAO (that IS the pool) registers task-types: each carries a spec hash, the
///         verification-policy reference (which gate verifies it), a share-weight, a priority,
///         and an enabled flag. Workers read it to know what to do; the TaskLaneCreditor reads
///         the weight; the dispatch policy reads priority.
interface ITaskRegistry {
    struct TaskType {
        bytes32 specHash;          // off-chain task spec
        address verificationGate;  // which ITaskVerificationGate verifies completions
        uint256 shareWeight;       // weight applied when crediting the TASK lane (1e18 = 1x)
        uint256 priority;          // dispatch priority
        bool enabled;
    }

    event TaskTypeSet(bytes32 indexed taskId, bytes32 specHash, address verificationGate, uint256 shareWeight, uint256 priority, bool enabled);

    function taskType(bytes32 taskId) external view returns (TaskType memory);
    function isEnabled(bytes32 taskId) external view returns (bool);
    function shareWeight(bytes32 taskId) external view returns (uint256);
}
