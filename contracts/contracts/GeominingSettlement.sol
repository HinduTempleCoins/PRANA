// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Read-only surface of the shared attestor stake registry. If wired, an attestor must be
///         `isActive` (stake >= minStake) for their geo-vouchers to settle — so a slashed/under-
///         staked attestor's signatures stop paying out without rotating any key.
interface IAttestorStake {
    function isActive(address attestor) external view returns (bool);
}

/// @title GeominingSettlement — location-claim reward settlement
/// @notice Players visit map "cells" (off-chain geofenced areas) and earn rewards. An off-chain
///         attestor holding ATTESTOR_ROLE — and, if a stake registry is wired, one that is still
///         `isActive` — signs an EIP-712 geo-voucher `(player, cellId, epoch, amount, nonce,
///         deadline)`. The player (or anyone) submits it via `claim`, which:
///           - verifies the signature came from a current, active ATTESTOR_ROLE holder,
///           - enforces a single-use `nonce` (replay guard),
///           - enforces a per-cell cooldown (no two claims on one cell inside `cellCooldown`),
///           - enforces a per-cell, per-epoch payout cap, and
///           - pays from a pre-funded ERC-20 pool (this contract's balance — NOT a minter).
///
///         TRUST MODEL (read carefully): this contract does NOT and CANNOT verify that a player
///         was physically at a location. GPS/location spoofing defense is entirely the attestor's
///         OFF-CHAIN job (sensor fusion, server-side checks, rate analysis). The chain only
///         enforces signature authenticity, single-use, cooldown, caps, and solvency. A
///         compromised attestor key can mis-attribute presence — which is exactly why the
///         attestor SHOULD be staked via the stake registry so it can be slashed out-of-band, and
///         why payouts come from a finite budget (bounded blast radius), not minting.
contract GeominingSettlement is AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "GeoVoucher(address player,uint256 cellId,uint256 epoch,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @notice Token paid out. This contract must be pre-funded; it is not a minter.
    IERC20 public immutable rewardToken;

    /// @notice Optional stake registry; if non-zero, attestors must be `isActive` there too.
    IAttestorStake public attestorStake;

    /// @notice Seconds that must elapse between two settled claims on the same cell.
    uint256 public cellCooldown;
    /// @notice Max total payout per cell per epoch.
    uint256 public cellEpochCap;

    mapping(uint256 => bool) public usedNonce;
    /// @dev cellId => last settlement timestamp (cooldown).
    mapping(uint256 => uint256) public cellLastClaimAt;
    /// @dev cellId => epoch => amount already paid out that epoch.
    mapping(uint256 => mapping(uint256 => uint256)) public cellEpochPaid;

    event Claimed(
        address indexed player,
        uint256 indexed cellId,
        uint256 indexed epoch,
        uint256 amount,
        uint256 nonce
    );
    event CellCooldownUpdated(uint256 cooldown);
    event CellEpochCapUpdated(uint256 cap);
    event AttestorStakeUpdated(address registry);
    event Funded(address indexed from, uint256 amount);
    event Rescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NonceAlreadyUsed(uint256 nonce);
    error VoucherExpired(uint256 deadline);
    error BadSigner(address recovered);
    error AttestorInactive(address attestor);
    error CellCooldownActive(uint256 readyAt);
    error CellEpochCapExceeded(uint256 requested, uint256 remaining);
    error PoolInsolvent(uint256 requested, uint256 balance);

    constructor(
        address admin,
        address attestor,
        IERC20 rewardToken_,
        IAttestorStake attestorStake_,
        uint256 cellCooldown_,
        uint256 cellEpochCap_
    ) EIP712("GeominingSettlement", "1") {
        if (admin == address(0) || attestor == address(0)) revert ZeroAddress();
        if (address(rewardToken_) == address(0)) revert ZeroAddress();
        if (cellEpochCap_ == 0) revert ZeroAmount();

        rewardToken = rewardToken_;
        attestorStake = attestorStake_; // may be zero == not wired
        cellCooldown = cellCooldown_;
        cellEpochCap = cellEpochCap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, attestor);
    }

    // --------------------------------------------------------------------- //
    //                              Admin config                             //
    // --------------------------------------------------------------------- //

    function setCellCooldown(uint256 v) external onlyRole(ADMIN_ROLE) {
        cellCooldown = v;
        emit CellCooldownUpdated(v);
    }

    function setCellEpochCap(uint256 v) external onlyRole(ADMIN_ROLE) {
        if (v == 0) revert ZeroAmount();
        cellEpochCap = v;
        emit CellEpochCapUpdated(v);
    }

    function setAttestorStake(IAttestorStake registry) external onlyRole(ADMIN_ROLE) {
        attestorStake = registry;
        emit AttestorStakeUpdated(address(registry));
    }

    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function rescue(address to, uint256 amount) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        rewardToken.safeTransfer(to, amount);
        emit Rescued(to, amount);
    }

    // --------------------------------------------------------------------- //
    //                                 Views                                 //
    // --------------------------------------------------------------------- //

    function hashVoucher(
        address player,
        uint256 cellId,
        uint256 epoch,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, player, cellId, epoch, amount, nonce, deadline))
        );
    }

    /// @notice Remaining payout for a cell within an epoch, after the cap.
    function remainingCellEpochBudget(uint256 cellId, uint256 epoch) external view returns (uint256) {
        uint256 used = cellEpochPaid[cellId][epoch];
        return used >= cellEpochCap ? 0 : cellEpochCap - used;
    }

    // --------------------------------------------------------------------- //
    //                                 Claim                                 //
    // --------------------------------------------------------------------- //

    /// @notice Settle an attestor-signed geo-voucher, paying `amount` to `player`.
    function claim(
        address player,
        uint256 cellId,
        uint256 epoch,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (player == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (usedNonce[nonce]) revert NonceAlreadyUsed(nonce);
        if (block.timestamp > deadline) revert VoucherExpired(deadline);

        _requireActiveAttestorSig(player, cellId, epoch, amount, nonce, deadline, signature);
        _enforceCellLimits(cellId, epoch, amount);

        {
            uint256 bal = rewardToken.balanceOf(address(this));
            if (bal < amount) revert PoolInsolvent(amount, bal);
        }

        // Effects.
        usedNonce[nonce] = true;
        cellLastClaimAt[cellId] = block.timestamp;
        cellEpochPaid[cellId][epoch] += amount;

        rewardToken.safeTransfer(player, amount);

        emit Claimed(player, cellId, epoch, amount, nonce);
    }

    /// @dev Verifies the signature recovered to a current ATTESTOR_ROLE holder that is also active
    ///      in the stake registry (when wired).
    function _requireActiveAttestorSig(
        address player,
        uint256 cellId,
        uint256 epoch,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private view {
        bytes32 digest = hashVoucher(player, cellId, epoch, amount, nonce, deadline);
        address recovered = ECDSA.recover(digest, signature);
        if (!hasRole(ATTESTOR_ROLE, recovered)) revert BadSigner(recovered);
        if (address(attestorStake) != address(0) && !attestorStake.isActive(recovered)) {
            revert AttestorInactive(recovered);
        }
    }

    /// @dev Enforces per-cell cooldown and per-cell per-epoch cap (no spend recorded here).
    function _enforceCellLimits(uint256 cellId, uint256 epoch, uint256 amount) private view {
        uint256 last = cellLastClaimAt[cellId];
        if (last != 0 && block.timestamp < last + cellCooldown) {
            revert CellCooldownActive(last + cellCooldown);
        }
        uint256 paid = cellEpochPaid[cellId][epoch];
        if (paid + amount > cellEpochCap) {
            revert CellEpochCapExceeded(amount, cellEpochCap - paid);
        }
    }
}
