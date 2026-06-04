// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IBridgeValidatorSet} from "../bridge/IBridgeValidatorSet.sol";

/// @notice Test-only {IBridgeValidatorSet}: a settable membership map + quorum, standing in for the
///         federated {FederatedBridgeValidatorSet} (BI1) until it lands.
contract MockBridgeValidatorSet is IBridgeValidatorSet {
    mapping(address => bool) private _isValidator;
    uint256 private _quorum;
    uint256 private _count;

    constructor(uint256 quorum_) {
        _quorum = quorum_;
    }

    function setValidator(address account, bool ok) external {
        if (ok && !_isValidator[account]) _count++;
        if (!ok && _isValidator[account]) _count--;
        _isValidator[account] = ok;
    }

    function setQuorum(uint256 quorum_) external {
        _quorum = quorum_;
    }

    function isValidator(address account) external view returns (bool) {
        return _isValidator[account];
    }

    function quorum() external view returns (uint256) {
        return _quorum;
    }

    function validatorCount() external view returns (uint256) {
        return _count;
    }
}
