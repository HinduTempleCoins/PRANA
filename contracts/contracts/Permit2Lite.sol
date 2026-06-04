// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title Permit2Lite — a minimal, Permit2-SHAPED SignatureTransfer.
/// @notice Lets a token owner sign an EIP-712 message authorizing a one-time pull of `amount` of
///         `token` to a chosen `spender`, with an unordered (bitmap) nonce and a deadline. The
///         owner approves THIS contract once (standard ERC-20 allowance); thereafter spenders pull
///         via signatures instead of per-pull approvals.
/// @dev ⚠️ Permit2-SHAPED, NOT canonical Uniswap Permit2. The struct/typehash here are a teaching
///      subset (single token, {token,amount,nonce,deadline,spender}) and do NOT match the official
///      Permit2 ABI or its witness/batched variants. PRODUCTION SYSTEMS SHOULD DEPLOY THE OFFICIAL
///      PERMIT2 BYTECODE (canonical address 0x000000000022D473030F116dDEE9F6B43aC78BA3) rather than
///      this contract.
contract Permit2Lite is EIP712 {
    using SafeERC20 for IERC20;

    /// @notice The signed transfer authorization.
    /// @param token The ERC-20 to pull.
    /// @param amount The exact amount authorized.
    /// @param nonce An unordered nonce (consumed via a bitmap; any unused value works once).
    /// @param deadline Unix time after which the signature is invalid.
    /// @param spender The address allowed to invoke the pull (and the funds' destination).
    struct PermitTransferFrom {
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        address spender;
    }

    /// @dev EIP-712 typehash for {PermitTransferFrom}.
    bytes32 public constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(address token,uint256 amount,uint256 nonce,uint256 deadline,address spender)"
    );

    /// @dev owner => word index => 256-bit bitmap of consumed nonces.
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    event NonceInvalidated(address indexed owner, uint256 nonce);

    error SignatureExpired(uint256 deadline);
    error InvalidNonce(uint256 nonce);
    error InvalidSigner(address signer, address owner);
    error AmountExceedsPermitted(uint256 requested, uint256 permitted);

    constructor() EIP712("Permit2Lite", "1") {}

    /// @notice The EIP-712 domain separator (exposed for off-chain signers/tests).
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Read whether a given nonce is already consumed for `owner`.
    function isNonceUsed(address owner, uint256 nonce) external view returns (bool) {
        (uint256 wordPos, uint256 bitPos) = _noncePosition(nonce);
        return (nonceBitmap[owner][wordPos] >> bitPos) & 1 == 1;
    }

    /// @notice Pull `requestedAmount` (<= signed amount) of the permit's token from `owner` to the
    ///         permit's spender, validating the EIP-712 signature, deadline, and unordered nonce.
    /// @param permit The signed authorization.
    /// @param owner The token owner who signed `permit` and approved this contract.
    /// @param requestedAmount The amount to actually transfer (must not exceed permit.amount).
    /// @param signature The owner's EIP-712 signature over `permit`.
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        address owner,
        uint256 requestedAmount,
        bytes calldata signature
    ) external {
        if (block.timestamp > permit.deadline) revert SignatureExpired(permit.deadline);
        if (requestedAmount > permit.amount) {
            revert AmountExceedsPermitted(requestedAmount, permit.amount);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TRANSFER_FROM_TYPEHASH,
                permit.token,
                permit.amount,
                permit.nonce,
                permit.deadline,
                permit.spender
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != owner) revert InvalidSigner(signer, owner);

        _useNonce(owner, permit.nonce);
        IERC20(permit.token).safeTransferFrom(owner, permit.spender, requestedAmount);
    }

    /// @notice Consume `nonce` for `owner`, reverting if already used.
    function _useNonce(address owner, uint256 nonce) internal {
        (uint256 wordPos, uint256 bitPos) = _noncePosition(nonce);
        uint256 bit = 1 << bitPos;
        uint256 flipped = nonceBitmap[owner][wordPos] ^= bit;
        // If the bit was already set, XOR cleared it -> the AND below is zero -> reuse.
        if (flipped & bit == 0) revert InvalidNonce(nonce);
        emit NonceInvalidated(owner, nonce);
    }

    /// @dev Split a nonce into its 256-word index and in-word bit position.
    function _noncePosition(uint256 nonce) internal pure returns (uint256 wordPos, uint256 bitPos) {
        wordPos = nonce >> 8;
        bitPos = nonce & 0xff;
    }
}
