// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VerifyingPaymaster
/// @notice Self-contained, gas-sponsorship-style paymaster abstraction (NOT a full
///         ERC-4337 EntryPoint). It holds a native deposit and lets a trusted
///         `verifyingSigner` authorize off-chain that a given user may have gas
///         sponsored up to `maxCost`. It also supports a token-paymaster mode where a
///         user pays for gas in an accepted stablecoin instead of native value.
/// @dev    Signatures are eth-signed (EIP-191 personal_sign) over
///         keccak256(abi.encodePacked(block.chainid, address(this), user, maxCost, nonce)).
///         Each nonce is single-use.
/// @dev    SECURITY (closes two threat-model findings): (1) the signed payload now binds
///         block.chainid + address(this), so a signature cannot be replayed on another chain
///         or against another deployment of this paymaster; (2) sponsorships are DEBITED against
///         the deposit (`totalSponsored` is reserved and must never exceed the balance), so one
///         deposit can no longer back unlimited sponsorships.
contract VerifyingPaymaster is Ownable {
    using SafeERC20 for IERC20;

    /// @notice The trusted off-chain signer that authorizes sponsorships.
    address public verifyingSigner;

    /// @notice Running total of native cost sponsored for each user (stand-in for
    ///         actually paying their gas out of the deposit).
    mapping(address => uint256) public sponsoredOf;

    /// @notice Total native value reserved by all sponsorships so far. Debited against the
    ///         deposit: a new sponsorship is only allowed if totalSponsored + maxCost <= balance.
    uint256 public totalSponsored;

    /// @notice Tracks consumed sponsorship nonces to enforce single-use authorizations.
    mapping(uint256 => bool) public usedNonce;

    event VerifyingSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event Sponsored(address indexed user, uint256 maxCost, uint256 nonce);
    event PaidInToken(address indexed user, address indexed token, uint256 amount);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroSigner();
    error NonceAlreadyUsed(uint256 nonce);
    error InvalidSignature();
    error InsufficientDeposit(uint256 available, uint256 required);
    error ZeroAmount();
    error WithdrawFailed();

    constructor(address initialOwner, address signer) Ownable(initialOwner) {
        if (signer == address(0)) revert ZeroSigner();
        verifyingSigner = signer;
    }

    /// @notice Owner can rotate the trusted verifying signer.
    function setVerifyingSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroSigner();
        emit VerifyingSignerUpdated(verifyingSigner, signer);
        verifyingSigner = signer;
    }

    /// @notice Recompute the eth-signed digest a sponsorship signature must cover. Binds
    ///         block.chainid + this paymaster's address so the signature is not replayable
    ///         across chains or deployments.
    function sponsorshipHash(address user, uint256 maxCost, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 raw = keccak256(
            abi.encodePacked(block.chainid, address(this), user, maxCost, nonce)
        );
        return MessageHashUtils.toEthSignedMessageHash(raw);
    }

    /// @notice Consume a signer-authorized sponsorship for `user` up to `maxCost`.
    /// @dev    Verifies the eth-signed signature recovers to `verifyingSigner`, enforces
    ///         single-use `nonce`, requires the deposit can cover `maxCost`, and records
    ///         the sponsored amount (a stand-in for paying gas from the deposit).
    function sponsor(address user, uint256 maxCost, uint256 nonce, bytes calldata signature)
        external
    {
        if (usedNonce[nonce]) revert NonceAlreadyUsed(nonce);
        // Debit against the deposit: the cumulative reserved amount must not exceed the balance,
        // so a single deposit cannot back unlimited sponsorships.
        uint256 reserved = totalSponsored + maxCost;
        if (address(this).balance < reserved) {
            revert InsufficientDeposit(address(this).balance, reserved);
        }

        bytes32 digest = sponsorshipHash(user, maxCost, nonce);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != verifyingSigner) revert InvalidSignature();

        usedNonce[nonce] = true;
        sponsoredOf[user] += maxCost;
        totalSponsored = reserved;

        emit Sponsored(user, maxCost, nonce);
    }

    /// @notice Token-paymaster mode: the caller pays for gas in an accepted stablecoin,
    ///         pulling `amount` of `token` from the caller to the paymaster owner.
    /// @dev    Caller must have approved this contract for at least `amount`.
    function payInToken(IERC20 token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, owner(), amount);
        emit PaidInToken(msg.sender, address(token), amount);
    }

    /// @notice Owner tops up the native deposit used to back sponsorships.
    function deposit() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Owner withdraws native value from the deposit. Cannot pull below the amount
    ///         already reserved by recorded sponsorships.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount + totalSponsored) {
            revert InsufficientDeposit(address(this).balance, amount + totalSponsored);
        }
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice Accept bare native transfers as deposits.
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }
}
