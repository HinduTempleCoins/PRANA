// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IBridgeValidatorSet} from "../interfaces/IBridgeValidatorSet.sol";

/// @title FederatedBridgeValidatorSet — a K-of-N validator set for the federated PRANA bridge (BI1)
///
/// @notice The trust upgrade over the single-custodian {PeggedBridgeVault}. Instead of ONE trusted
///         key signing off on cross-chain mints/releases, a set of N validators is maintained on
///         chain and any bridge action requires a quorum of K = {threshold} DISTINCT validators to
///         have signed the action's digest. A bridge endpoint (e.g. {CanonicalLockMintBridge})
///         calls {verifySignatures} to gate its mint/release.
///
///         The validator set itself is governed by {DEFAULT_ADMIN_ROLE} — intended to be held by
///         the PRANA DAO / timelock — which can add/remove validators, change the threshold, and
///         atomically rotate (swap) a validator key. This is still a *federated* (permissioned)
///         trust model — security rests on the honesty of K-of-N validators — but it removes the
///         single point of failure and makes the trust set transparent and DAO-governed.
///
/// @dev SIGNATURE CONVENTION (must match relayers/tests):
///        validators sign the EIP-191 "Ethereum Signed Message" of the raw 32-byte `digest`
///        (i.e. `personal_sign` / ethers `signMessage(getBytes(digest))`). On-chain we recover via
///        `ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), sig)`. The `digest` is
///        produced by the calling bridge endpoint and is opaque to this contract.
contract FederatedBridgeValidatorSet is AccessControl, IBridgeValidatorSet {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Set of current validator addresses.
    EnumerableSet.AddressSet private _validators;

    /// @notice K — the number of distinct valid validator signatures a quorum needs.
    uint256 private _threshold;

    // --- events ------------------------------------------------------------ //
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ValidatorRotated(address indexed oldValidator, address indexed newValidator);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);

    // --- errors ------------------------------------------------------------ //
    error ZeroAddress();
    error AlreadyValidator(address validator);
    error NotValidator(address validator);
    error InvalidThreshold(uint256 threshold, uint256 validatorCount);
    error EmptyValidatorSet();

    /// @param admin           receives DEFAULT_ADMIN_ROLE (the DAO / timelock governs the set).
    /// @param initialValidators the genesis validator set (N); must be non-empty and distinct.
    /// @param initialThreshold the genesis quorum K; must satisfy 1 <= K <= N.
    constructor(address admin, address[] memory initialValidators, uint256 initialThreshold) {
        if (admin == address(0)) revert ZeroAddress();
        if (initialValidators.length == 0) revert EmptyValidatorSet();

        for (uint256 i; i < initialValidators.length; ++i) {
            address v = initialValidators[i];
            if (v == address(0)) revert ZeroAddress();
            if (!_validators.add(v)) revert AlreadyValidator(v); // also rejects duplicates in the array
            emit ValidatorAdded(v);
        }

        if (initialThreshold == 0 || initialThreshold > _validators.length()) {
            revert InvalidThreshold(initialThreshold, _validators.length());
        }
        _threshold = initialThreshold;
        emit ThresholdChanged(0, initialThreshold);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ===================================================================== //
    //                          Governance (DAO/admin)                       //
    // ===================================================================== //

    /// @notice Add `validator` to the set. Threshold is unchanged (N grows, K stays).
    function addValidator(address validator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (validator == address(0)) revert ZeroAddress();
        if (!_validators.add(validator)) revert AlreadyValidator(validator);
        emit ValidatorAdded(validator);
    }

    /// @notice Remove `validator` from the set. Reverts if doing so would drop N below the current
    ///         threshold K (would make quorum unreachable) — lower the threshold first.
    function removeValidator(address validator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_validators.remove(validator)) revert NotValidator(validator);
        if (_validators.length() < _threshold) {
            revert InvalidThreshold(_threshold, _validators.length());
        }
        emit ValidatorRemoved(validator);
    }

    /// @notice Atomically replace `oldValidator` with `newValidator` (key rotation). N and K
    ///         unchanged. `newValidator` must not already be in the set.
    function rotateValidator(address oldValidator, address newValidator)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newValidator == address(0)) revert ZeroAddress();
        if (_validators.contains(newValidator)) revert AlreadyValidator(newValidator);
        if (!_validators.remove(oldValidator)) revert NotValidator(oldValidator);
        _validators.add(newValidator); // cannot fail: removed old, new not present
        emit ValidatorRotated(oldValidator, newValidator);
    }

    /// @notice Set the quorum threshold K. Must satisfy 1 <= K <= N (current validator count).
    function setThreshold(uint256 newThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 n = _validators.length();
        if (newThreshold == 0 || newThreshold > n) revert InvalidThreshold(newThreshold, n);
        uint256 old = _threshold;
        _threshold = newThreshold;
        emit ThresholdChanged(old, newThreshold);
    }

    // ===================================================================== //
    //                         IBridgeValidatorSet views                     //
    // ===================================================================== //

    /// @inheritdoc IBridgeValidatorSet
    function isValidator(address account) public view returns (bool) {
        return _validators.contains(account);
    }

    /// @inheritdoc IBridgeValidatorSet
    function threshold() external view returns (uint256) {
        return _threshold;
    }

    /// @inheritdoc IBridgeValidatorSet
    function validatorCount() public view returns (uint256) {
        return _validators.length();
    }

    /// @notice Enumerate the validator at `index` (for off-chain tooling / relayers).
    function validatorAt(uint256 index) external view returns (address) {
        return _validators.at(index);
    }

    /// @notice Full validator list snapshot.
    function validators() external view returns (address[] memory) {
        return _validators.values();
    }

    /// @inheritdoc IBridgeValidatorSet
    /// @dev Recovers the signer of each entry in `sigs` over the EIP-191 prefixed `digest`, and
    ///      returns true iff at least {threshold} DISTINCT current validators are recovered.
    ///      Duplicate signers count once; non-validator or malformed signatures are ignored.
    function verifySignatures(bytes32 digest, bytes[] calldata sigs)
        external
        view
        returns (bool)
    {
        uint256 required = _threshold;
        bytes32 ethDigest = MessageHashUtils.toEthSignedMessageHash(digest);

        // Track distinct valid signers seen so far in `seen` to reject duplicates.
        address[] memory seen = new address[](sigs.length);
        uint256 distinct;

        for (uint256 i; i < sigs.length; ++i) {
            (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethDigest, sigs[i]);
            if (err != ECDSA.RecoverError.NoError) continue; // malformed signature → skip
            if (!_validators.contains(signer)) continue; // not a current validator → skip

            // Reject duplicate signer (same validator signing twice does not add to quorum).
            bool dup;
            for (uint256 j; j < distinct; ++j) {
                if (seen[j] == signer) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;

            seen[distinct++] = signer;
            if (distinct >= required) return true;
        }
        return false;
    }
}
