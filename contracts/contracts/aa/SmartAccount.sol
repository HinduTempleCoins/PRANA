// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {PackedUserOperation} from "./PackedUserOperation.sol";
import {SessionKeyValidator} from "./SessionKeyValidator.sol";

/// @title SmartAccount — a minimal ERC-4337 v0.7 smart account
/// @notice Owner-controlled account that validates user operations for a (test-harness or
///         canonical) EntryPoint. Primary auth is an owner ECDSA signature over the EIP-191
///         eth-signed `userOpHash`. An OPTIONAL `SessionKeyValidator` module provides a
///         fallback: an op signed by a registered, in-scope session key validates with the
///         session's time-range packed into `validationData` (the EntryPoint enforces it).
/// @dev    Targets the v0.7 IAccount interface — `validateUserOp(op, opHash, missingFunds)`
///         returns packed `validationData` and forwards any `missingAccountFunds` to the
///         EntryPoint. The local `MinimalEntryPoint` debits its own deposit accounting, so it
///         passes missingFunds == 0; against a canonical EntryPoint the prefund branch sends
///         the requested top-up. The signature payload is `abi.encode(signer, sig)` where
///         `signer` is the owner OR a session key; selecting the path by an explicit signer
///         keeps validation branch-free of trial recovery.
contract SmartAccount is IERC1271 {
    using ECDSA for bytes32;

    /// @dev v0.7 packed validationData: low 160 bits = aggregator/sig-status.
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    /// @dev EIP-1271 magic value for a valid signature.
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    address public immutable entryPoint;
    address public owner;
    /// @notice Optional session-key module; address(0) ⇒ owner-only.
    SessionKeyValidator public sessionValidator;

    event OwnerRotated(address indexed previousOwner, address indexed newOwner);
    event SessionValidatorSet(address indexed previousValidator, address indexed newValidator);
    event Executed(address indexed to, uint256 value, bytes data);

    error NotEntryPoint();
    error NotOwner();
    error NotEntryPointOrOwner();
    error ZeroOwner();
    error ExecuteFailed(bytes ret);
    error BadBatchLengths();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    constructor(address entryPoint_, address owner_) {
        if (owner_ == address(0)) revert ZeroOwner();
        entryPoint = entryPoint_;
        owner = owner_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Configuration (owner-gated)
    // ---------------------------------------------------------------------

    /// @notice Rotate the owner key (owner-only).
    function rotateOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
        emit OwnerRotated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Set (or clear, with address(0)) the optional session-key module (owner-only).
    function setSessionValidator(SessionKeyValidator validator) external onlyOwner {
        emit SessionValidatorSet(address(sessionValidator), address(validator));
        sessionValidator = validator;
    }

    // ---------------------------------------------------------------------
    // ERC-4337 v0.7 validation
    // ---------------------------------------------------------------------

    /// @notice Validate a user operation for the EntryPoint and (optionally) pay prefund.
    /// @param op                  the user operation.
    /// @param userOpHash          EntryPoint-computed hash (binds op to entryPoint + chainId).
    /// @param missingAccountFunds amount the account must send to the EntryPoint to cover the op.
    /// @return validationData     v0.7 packed: 0 ⇒ valid (owner), SIG_VALIDATION_FAILED ⇒ bad sig,
    ///                            or (validUntil<<160 | validAfter<<208) for a session-key op.
    function validateUserOp(
        PackedUserOperation calldata op,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external onlyEntryPoint returns (uint256 validationData) {
        validationData = _validateSignature(op, userOpHash);
        _payPrefund(missingAccountFunds);
    }

    /// @dev Resolve the explicit signer from `op.signature = abi.encode(signer, sig)`, then:
    ///      - signer == owner ⇒ verify owner ECDSA over the eth-signed userOpHash.
    ///      - else ⇒ treat signer as a session key: verify its ECDSA AND that the op's decoded
    ///        execute(to,value,data) is in-scope; record the spend; return the time-range packed.
    /// @dev NOT view: the session path records spend here. In this stack validation and execution
    ///      run atomically in one `handleOps` tx, so recording at validation is safe (the op cannot
    ///      validate-then-not-execute). A canonical EntryPoint would record spend in the execute
    ///      path instead; documented in the AA design notes.
    function _validateSignature(PackedUserOperation calldata op, bytes32 userOpHash)
        internal
        returns (uint256)
    {
        (address signer, bytes memory sig) = abi.decode(op.signature, (address, bytes));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(userOpHash);

        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethHash, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) {
            return SIG_VALIDATION_FAILED;
        }

        if (signer == owner) {
            return SIG_VALIDATION_SUCCESS;
        }

        // Session-key fallback (only if a module is wired).
        if (address(sessionValidator) == address(0)) {
            return SIG_VALIDATION_FAILED;
        }
        return _validateSession(signer, op.callData);
    }

    /// @dev Decode the account's own `execute(to,value,data)` self-call from `callData`, ask the
    ///      module if `signer` may do it, record the spend, and pack the session time-range into
    ///      validationData. Any out-of-scope/expired session reverts inside the module → sig-fail.
    function _validateSession(address signer, bytes calldata callData) internal returns (uint256) {
        // Must be a single execute(address,uint256,bytes) call (selector + args).
        if (callData.length < 4 || bytes4(callData[0:4]) != this.execute.selector) {
            return SIG_VALIDATION_FAILED;
        }
        (address to, uint256 value, bytes memory innerData) =
            abi.decode(callData[4:], (address, uint256, bytes));

        bytes4 innerSelector = _leadingSelector(innerData);

        try sessionValidator.validateSession(address(this), signer, to, innerSelector, value)
            returns (uint48 validAfter, uint48 validUntil)
        {
            // Scope OK → record spend, then pack the time-range (sigAuthorizer low 160 = 0).
            sessionValidator.recordSpend(signer, value);
            return (uint256(validUntil) << 160) | (uint256(validAfter) << (160 + 48));
        } catch {
            return SIG_VALIDATION_FAILED;
        }
    }

    /// @dev Read the leading 4-byte selector from a `bytes memory` payload (0 if shorter than 4).
    function _leadingSelector(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(data, 0x20))
        }
    }

    /// @dev Forward `missingAccountFunds` to the EntryPoint (no-op when 0, e.g. the harness).
    function _payPrefund(uint256 missingAccountFunds) internal {
        if (missingAccountFunds == 0) return;
        (bool ok, ) = payable(entryPoint).call{value: missingAccountFunds}("");
        ok; // EntryPoint settles; ignore failure per v0.7 (validation must not revert on prefund).
    }

    // ---------------------------------------------------------------------
    // Execution (EntryPoint or owner)
    // ---------------------------------------------------------------------

    /// @notice Execute a single call. Callable by the EntryPoint (via a validated op) or the owner.
    /// @dev    Session-key spend accounting happens during validation (atomic with execution in
    ///         this stack), so the execute path itself is auth-only.
    function execute(address to, uint256 value, bytes calldata data) external {
        _requireEntryPointOrOwner();
        _call(to, value, data);
    }

    /// @notice Execute a batch of calls atomically. Same auth as `execute`.
    function executeBatch(
        address[] calldata to,
        uint256[] calldata value,
        bytes[] calldata data
    ) external {
        _requireEntryPointOrOwner();
        if (to.length != value.length || to.length != data.length) revert BadBatchLengths();
        for (uint256 i; i < to.length; ++i) {
            _call(to[i], value[i], data[i]);
        }
    }

    function _requireEntryPointOrOwner() internal view {
        if (msg.sender != entryPoint && msg.sender != owner) revert NotEntryPointOrOwner();
    }

    function _call(address to, uint256 value, bytes calldata data) internal {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert ExecuteFailed(ret);
        emit Executed(to, value, data);
    }

    // ---------------------------------------------------------------------
    // EIP-1271 — contract signature verification
    // ---------------------------------------------------------------------

    /// @notice EIP-1271: returns the magic value iff `signature` is a valid OWNER signature over
    ///         the EIP-191 eth-signed `hash`. (Session keys are op-scoped and not honored here.)
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        override
        returns (bytes4 magicValue)
    {
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(hash);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethHash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return ERC1271_MAGIC;
        }
        return 0xffffffff;
    }
}
