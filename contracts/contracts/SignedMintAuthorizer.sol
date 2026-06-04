// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IMintable} from "./BurnMine.sol";

/// @title SignedMintAuthorizer — off-chain-voucher mint gate
/// @notice A trusted `signer` (fixed at deploy) authorizes mints off-chain by signing vouchers
///         `(to, amount, nonce)`. Anyone holding a valid voucher can redeem it on-chain via
///         `claim`, which verifies the signature, enforces single-use nonces, and mints the
///         output token. This lets minting authority live off-chain (an allowlist server, a
///         faucet, a reward oracle) while the chain only trusts one signing key.
///
///         Requirements:
///           - this contract must hold the minter authority on `token` (e.g. MINTER_ROLE).
///
///         The voucher digest is `keccak256(abi.encodePacked(to, amount, nonce))`, wrapped with
///         the standard Ethereum Signed Message prefix so wallets / `eth_sign`-style signing
///         (e.g. ethers `signMessage`) produce a recoverable signature.
contract SignedMintAuthorizer {
    /// @notice Token to mint. Must grant this contract minter authority.
    IMintable public immutable token;

    /// @notice The only key whose vouchers are honored.
    address public immutable signer;

    /// @notice Tracks consumed nonces so each voucher can be redeemed at most once.
    mapping(uint256 => bool) public usedNonce;

    event Claimed(address indexed to, uint256 amount, uint256 indexed nonce);

    constructor(IMintable token_, address signer_) {
        require(address(token_) != address(0), "token=0");
        require(signer_ != address(0), "signer=0");
        token = token_;
        signer = signer_;
    }

    /// @notice Redeem a signed voucher, minting `amount` of `token` to `to`.
    /// @param to        recipient of the minted tokens (bound into the signature)
    /// @param amount    amount to mint (bound into the signature)
    /// @param nonce     single-use voucher id (bound into the signature)
    /// @param signature `signer`'s signature over the prefixed voucher digest
    function claim(address to, uint256 amount, uint256 nonce, bytes calldata signature) external {
        require(!usedNonce[nonce], "nonce used");

        bytes32 digest = keccak256(abi.encodePacked(to, amount, nonce));
        bytes32 ethDigest = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethDigest, signature);
        require(recovered == signer, "bad signer");

        usedNonce[nonce] = true;
        token.mint(to, amount);

        emit Claimed(to, amount, nonce);
    }
}
