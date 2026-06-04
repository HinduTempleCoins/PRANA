// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IWorkerBeacon} from "../../interfaces/IWorkerBeacon.sol";

/// @notice Test-only IWorkerBeacon: tests toggle which workers are "bound".
contract MockWorkerBeacon is IWorkerBeacon {
    mapping(address => bool) private _bound;

    function setBound(address worker, bool bound) external {
        _bound[worker] = bound;
    }

    function isBound(address worker) external view override returns (bool) {
        return _bound[worker];
    }
}
