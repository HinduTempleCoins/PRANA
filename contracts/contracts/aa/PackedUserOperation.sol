// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title PackedUserOperation — the ERC-4337 v0.7 user-operation struct
/// @notice Mirrors the canonical EntryPoint v0.7 `PackedUserOperation` layout. The two
///         "packed" fields encode two uint128 values each:
///           - `accountGasLimits`  = (verificationGasLimit << 128) | callGasLimit
///           - `gasFees`           = (maxPriorityFeePerGas << 128) | maxFeePerGas
///         `paymasterAndData` is empty when no paymaster is used; otherwise it is
///           [paymaster (20 bytes)][paymasterVerificationGasLimit (16)][paymasterPostOpGasLimit (16)][extra...].
/// @dev    This is a faithful v0.7 INTERFACE struct so a canonical EntryPoint can later
///         replace the local test harness in `MinimalEntryPoint.sol` without changing the
///         account/paymaster code. The harness simplifies the *gas market* only — never
///         the struct shape or the hashing.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @title UserOperationLib — v0.7 packing/hashing helpers
/// @notice The op hash binds the op fields to a specific `entryPoint` and `chainId`, exactly
///         like the canonical v0.7 EntryPoint: the signed digest is
///         keccak256(abi.encode(hashOfPackedOp, entryPoint, chainId)).
/// @dev    The inner `hash()` excludes the `signature` field (signature signs over everything
///         else), matching v0.7. We hash the dynamic byte fields rather than re-pack them
///         into calldata words to keep stack depth shallow and the implementation simple.
library UserOperationLib {
    /// @notice Split `accountGasLimits` into (verificationGasLimit, callGasLimit).
    function unpackAccountGasLimits(PackedUserOperation calldata op)
        internal
        pure
        returns (uint256 verificationGasLimit, uint256 callGasLimit)
    {
        verificationGasLimit = uint128(bytes16(op.accountGasLimits));
        callGasLimit = uint128(uint256(op.accountGasLimits));
    }

    /// @notice Split `gasFees` into (maxPriorityFeePerGas, maxFeePerGas).
    function unpackGasFees(PackedUserOperation calldata op)
        internal
        pure
        returns (uint256 maxPriorityFeePerGas, uint256 maxFeePerGas)
    {
        maxPriorityFeePerGas = uint128(bytes16(op.gasFees));
        maxFeePerGas = uint128(uint256(op.gasFees));
    }

    /// @notice Hash of the op WITHOUT the signature (the inner hash, per v0.7).
    function hash(PackedUserOperation calldata op) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(op.paymasterAndData)
            )
        );
    }

    /// @notice The full userOpHash an account signs: binds the op to `entryPoint` + `chainId`.
    function userOpHash(
        PackedUserOperation calldata op,
        address entryPoint,
        uint256 chainId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(hash(op), entryPoint, chainId));
    }
}
