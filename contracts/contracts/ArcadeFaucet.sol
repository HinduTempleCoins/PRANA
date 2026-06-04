// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ArcadeFaucet — rate-limited reward faucet for game / offerwall scores
/// @notice An off-chain attester (ATTESTER_ROLE) watches game/offerwall activity and signs an
///         EIP-712 voucher `(player, amount, scoreRef, deadline, nonce)`. Anyone holding the
///         voucher can redeem it; the faucet verifies the signature, enforces single-use
///         nonces, a per-player cooldown, a per-player daily cap AND a global daily budget,
///         then pays out from its OWN pre-funded reward-token balance.
/// @dev    The faucet is NOT a minter. It pays from a finite, pre-funded balance, so the daily
///         caps and the balance itself are real economic constraints (a hard sink-backed
///         budget) — an attacker who compromises the attester key still cannot mint, only
///         drain at most one day's global budget at a time.
///
///         "Day" buckets are fixed UTC-style windows: `block.timestamp / 1 days`. Caps reset
///         lazily when a new day index is observed; there is no keeper.
contract ArcadeFaucet is AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to sign redeemable vouchers (rotatable via grant/revoke).
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    /// @notice Role allowed to tune cooldown / caps and rescue funds.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev EIP-712 typehash for the reward voucher.
    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)"
    );

    /// @notice The token paid out as rewards. The faucet must be pre-funded with this token.
    IERC20 public immutable rewardToken;

    /// @notice Seconds a player must wait between two successful claims.
    uint256 public cooldown;
    /// @notice Maximum reward a single player can claim within one day window.
    uint256 public perPlayerDailyCap;
    /// @notice Maximum reward the faucet pays out across all players within one day window.
    uint256 public globalDailyCap;

    /// @dev Single-use voucher nonces, tracked per nonce value.
    mapping(uint256 => bool) public usedNonce;
    /// @dev Last successful claim timestamp per player (for cooldown).
    mapping(address => uint256) public lastClaimAt;

    /// @dev player => day index => amount already claimed that day.
    mapping(address => mapping(uint256 => uint256)) public playerClaimedOnDay;
    /// @dev day index => total paid out globally that day.
    mapping(uint256 => uint256) public globalClaimedOnDay;

    event Claimed(
        address indexed player,
        uint256 amount,
        bytes32 indexed scoreRef,
        uint256 indexed nonce,
        uint256 day
    );
    event CooldownUpdated(uint256 cooldown);
    event PerPlayerDailyCapUpdated(uint256 cap);
    event GlobalDailyCapUpdated(uint256 cap);
    event Funded(address indexed from, uint256 amount);
    event Rescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NonceAlreadyUsed(uint256 nonce);
    error VoucherExpired(uint256 deadline);
    error BadSigner(address recovered);
    error CooldownActive(uint256 readyAt);
    error PerPlayerCapExceeded(uint256 requested, uint256 remaining);
    error GlobalCapExceeded(uint256 requested, uint256 remaining);
    error FaucetInsolvent(uint256 requested, uint256 balance);

    /// @param admin            Address granted DEFAULT_ADMIN_ROLE + ADMIN_ROLE.
    /// @param attester         Initial ATTESTER_ROLE holder (the off-chain signer).
    /// @param rewardToken_     Token paid out as rewards (faucet pays from its own balance).
    /// @param cooldown_        Seconds between successful claims per player.
    /// @param perPlayerDailyCap_ Per-player per-day reward cap.
    /// @param globalDailyCap_  Global per-day reward budget.
    constructor(
        address admin,
        address attester,
        IERC20 rewardToken_,
        uint256 cooldown_,
        uint256 perPlayerDailyCap_,
        uint256 globalDailyCap_
    ) EIP712("ArcadeFaucet", "1") {
        if (admin == address(0) || attester == address(0)) revert ZeroAddress();
        if (address(rewardToken_) == address(0)) revert ZeroAddress();
        if (perPlayerDailyCap_ == 0 || globalDailyCap_ == 0) revert ZeroAmount();

        rewardToken = rewardToken_;
        cooldown = cooldown_;
        perPlayerDailyCap = perPlayerDailyCap_;
        globalDailyCap = globalDailyCap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, attester);
    }

    // --------------------------------------------------------------------- //
    //                              Admin config                             //
    // --------------------------------------------------------------------- //

    function setCooldown(uint256 cooldown_) external onlyRole(ADMIN_ROLE) {
        cooldown = cooldown_;
        emit CooldownUpdated(cooldown_);
    }

    function setPerPlayerDailyCap(uint256 cap) external onlyRole(ADMIN_ROLE) {
        if (cap == 0) revert ZeroAmount();
        perPlayerDailyCap = cap;
        emit PerPlayerDailyCapUpdated(cap);
    }

    function setGlobalDailyCap(uint256 cap) external onlyRole(ADMIN_ROLE) {
        if (cap == 0) revert ZeroAmount();
        globalDailyCap = cap;
        emit GlobalDailyCapUpdated(cap);
    }

    /// @notice Pull `amount` of the reward token from the caller into the faucet.
    /// @dev    Convenience top-up; a plain transfer to this contract also works.
    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Admin recovers unspent reward tokens.
    function rescue(address to, uint256 amount) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        rewardToken.safeTransfer(to, amount);
        emit Rescued(to, amount);
    }

    // --------------------------------------------------------------------- //
    //                                Views                                  //
    // --------------------------------------------------------------------- //

    /// @notice Current day index used for the rolling caps.
    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice EIP-712 digest a voucher signature must cover (handy for off-chain signers/tests).
    function hashVoucher(
        address player,
        uint256 amount,
        bytes32 scoreRef,
        uint256 deadline,
        uint256 nonce
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, player, amount, scoreRef, deadline, nonce))
        );
    }

    /// @notice Reward still claimable by `player` today, after per-player cap.
    function remainingPlayerBudget(address player) external view returns (uint256) {
        uint256 used = playerClaimedOnDay[player][currentDay()];
        return used >= perPlayerDailyCap ? 0 : perPlayerDailyCap - used;
    }

    /// @notice Reward still payable globally today, after the global cap.
    function remainingGlobalBudget() external view returns (uint256) {
        uint256 used = globalClaimedOnDay[currentDay()];
        return used >= globalDailyCap ? 0 : globalDailyCap - used;
    }

    // --------------------------------------------------------------------- //
    //                                Claim                                  //
    // --------------------------------------------------------------------- //

    /// @notice Redeem an attester-signed voucher, paying `amount` of the reward token to `player`.
    /// @param player    recipient bound into the signature
    /// @param amount    reward amount bound into the signature
    /// @param scoreRef  opaque off-chain score/job reference (logged, bound into the signature)
    /// @param deadline  unix time after which the voucher is no longer valid
    /// @param nonce     single-use voucher id bound into the signature
    /// @param signature ATTESTER_ROLE signature over the EIP-712 voucher digest
    function claim(
        address player,
        uint256 amount,
        bytes32 scoreRef,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) external {
        if (player == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (usedNonce[nonce]) revert NonceAlreadyUsed(nonce);
        if (block.timestamp > deadline) revert VoucherExpired(deadline);

        _requireAttesterSig(player, amount, scoreRef, deadline, nonce, signature);

        // Cooldown.
        {
            uint256 last = lastClaimAt[player];
            if (last != 0 && block.timestamp < last + cooldown) {
                revert CooldownActive(last + cooldown);
            }
        }

        // Daily caps (checks + effects, internal to keep the stack shallow).
        uint256 day = _chargeDailyCaps(player, amount);

        // Real-budget constraint: faucet pays from its own balance.
        {
            uint256 bal = rewardToken.balanceOf(address(this));
            if (bal < amount) revert FaucetInsolvent(amount, bal);
        }

        // Effects.
        usedNonce[nonce] = true;
        lastClaimAt[player] = block.timestamp;

        // Interaction.
        rewardToken.safeTransfer(player, amount);

        emit Claimed(player, amount, scoreRef, nonce, day);
    }

    /// @dev Reverts unless `signature` is a current ATTESTER_ROLE holder's EIP-712 voucher signature.
    function _requireAttesterSig(
        address player,
        uint256 amount,
        bytes32 scoreRef,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) internal view {
        bytes32 digest = hashVoucher(player, amount, scoreRef, deadline, nonce);
        address recovered = ECDSA.recover(digest, signature);
        if (!hasRole(ATTESTER_ROLE, recovered)) revert BadSigner(recovered);
    }

    /// @dev Enforces the per-player and global daily caps and records the spend. Returns the day bucket.
    function _chargeDailyCaps(address player, uint256 amount) internal returns (uint256 day) {
        day = currentDay();
        uint256 playerUsed = playerClaimedOnDay[player][day];
        if (playerUsed + amount > perPlayerDailyCap) {
            revert PerPlayerCapExceeded(amount, perPlayerDailyCap - playerUsed);
        }
        uint256 globalUsed = globalClaimedOnDay[day];
        if (globalUsed + amount > globalDailyCap) {
            revert GlobalCapExceeded(amount, globalDailyCap - globalUsed);
        }
        playerClaimedOnDay[player][day] = playerUsed + amount;
        globalClaimedOnDay[day] = globalUsed + amount;
    }
}
