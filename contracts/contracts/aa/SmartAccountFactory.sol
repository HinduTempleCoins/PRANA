// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SmartAccount} from "./SmartAccount.sol";

/// @title SmartAccountFactory — CREATE2 deployer for SmartAccount
/// @notice Deploys SmartAccounts at deterministic addresses so a counterfactual account address
///         can be known (and funded) before deployment — the standard ERC-4337 pattern. All
///         accounts share one immutable `entryPoint`; the (owner, salt) pair determines the
///         address.
/// @dev    `createAccount` is idempotent: if the account already exists at the predicted address
///         it returns it instead of redeploying (so it is safe to call from initCode repeatedly).
contract SmartAccountFactory {
    address public immutable entryPoint;

    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    /// @notice Deploy (or return the existing) SmartAccount for `owner` under `salt`.
    function createAccount(address owner, bytes32 salt) external returns (SmartAccount account) {
        address predicted = predictAddress(owner, salt);
        if (predicted.code.length > 0) {
            return SmartAccount(payable(predicted));
        }
        account = new SmartAccount{salt: salt}(entryPoint, owner);
        emit AccountCreated(address(account), owner, salt);
    }

    /// @notice Counterfactual address for (owner, salt) under this factory's CREATE2.
    function predictAddress(address owner, bytes32 salt) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(SmartAccount).creationCode,
                abi.encode(entryPoint, owner)
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}
