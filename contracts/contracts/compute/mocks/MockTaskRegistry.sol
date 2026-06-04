// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ITaskRegistry} from "../../interfaces/ITaskRegistry.sol";

/// @notice Test-only ITaskRegistry: lets tests set a task-type's weight/enabled so TaskLaneCreditor
///         can be exercised without the real (sibling-built) TaskRegistry.
contract MockTaskRegistry is ITaskRegistry {
    mapping(bytes32 => TaskType) private _types;

    function set(bytes32 taskId, uint256 weight, bool enabled) external {
        _types[taskId] = TaskType({
            specHash: bytes32(0),
            verificationGate: address(0),
            shareWeight: weight,
            priority: 0,
            enabled: enabled
        });
        emit TaskTypeSet(taskId, bytes32(0), address(0), weight, 0, enabled);
    }

    function taskType(bytes32 taskId) external view override returns (TaskType memory) {
        return _types[taskId];
    }

    function isEnabled(bytes32 taskId) external view override returns (bool) {
        return _types[taskId].enabled;
    }

    function shareWeight(bytes32 taskId) external view override returns (uint256) {
        return _types[taskId].shareWeight;
    }
}
