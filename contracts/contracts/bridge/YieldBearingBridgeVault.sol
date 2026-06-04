// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PausableGuardian} from "../PausableGuardian.sol";
import {IBridgeValidatorSet} from "../interfaces/IBridgeValidatorSet.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

/// @title YieldBearingBridgeVault (BI6) — ⛔ GATED by UD-BI-F. Lock-release bridge vault whose idle
///        TVL earns yield for a configured beneficiary, while principal stays 1:1 redeemable.
///
/// @notice ⚠️⚠️ OPTIONAL / GATED. UD-BI-F is the USER DECISION: "earn yield on bridged TVL" vs "keep
///         TVL idle". This contract implements the YIELD-ON option. If the user picks the idle option,
///         use {PeggedBridgeVault} / the canonical bridge instead and DO NOT deploy this.
///
///         A single-asset LOCK_RELEASE bridge vault: users lock `asset`; an attested K-of-N
///         {IBridgeValidatorSet} message releases it on the far side's instruction. Unlike a plain
///         vault, locked principal is forwarded into an injected {IYieldStrategy} so it is not idle.
///         The vault tracks `principal` (the exact amount owed back to bridge users, redeemable 1:1)
///         separately from the strategy's `totalAssets()`. The surplus
///         (`strategy.totalAssets() - principal`) is YIELD, harvestable ONLY to a configured
///         `yieldBeneficiary` — principal is never touched by a harvest.
///
/// @dev    SAFETY MODEL & ASSUMPTIONS:
///         - The vault keeps NO operating float by default: on lock it deposits 100% to the strategy.
///           On release it withdraws exactly `amount` from the strategy. The strategy MUST honor any
///           `withdraw(amount)` with `amount <= principal` (see {IYieldStrategy}).
///         - 1:1 redeemability requires `strategy.totalAssets() >= principal` ALWAYS. A strategy that
///           can lose principal breaks this invariant; only principal-safe strategies may be wired.
///           A guardian PAUSE + the per-token daily release cap bound blast radius if a strategy
///           misbehaves.
///         - Single-asset by construction: `asset` and `strategy` are immutable; the strategy's
///           `asset()` must equal this vault's `asset`.
contract YieldBearingBridgeVault is PausableGuardian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant DOMAIN = "PRANA.YieldBearingBridgeVault.v1";

    /// @notice The single bridged asset.
    IERC20 public immutable asset;

    /// @notice The injected yield source idle principal is deployed into.
    IYieldStrategy public immutable strategy;

    /// @notice K-of-N attestation authority (shared with the canonical bridge).
    IBridgeValidatorSet public immutable validatorSet;

    /// @notice EVM chain id of the linked remote network.
    uint256 public immutable remoteChainId;

    /// @notice Exact amount owed back to bridge users (redeemable 1:1). Yield is anything above this.
    uint256 public principal;

    /// @notice Where harvested yield is sent. Set by admin; harvest reverts until configured.
    address public yieldBeneficiary;

    /// @notice Monotonic outbound nonce.
    uint256 public outboundNonce;

    /// @notice Per-MESSAGE replay guard over the inbound message hash.
    mapping(bytes32 => bool) public consumedMessage;

    // --- daily release cap (rolling 24h window) ----------------------------
    uint256 public constant DAY = 1 days;
    uint256 public dailyCap;
    uint256 public releasedInWindow;
    uint256 public windowStart;

    // --- events ------------------------------------------------------------
    event YieldBeneficiarySet(address indexed beneficiary);
    event DailyCapSet(uint256 cap);
    event BridgeLocked(bytes32 indexed messageHash, uint256 indexed nonce, address indexed sender, uint256 amount, bytes32 destinationRef);
    event BridgeReleased(bytes32 indexed messageHash, uint256 indexed srcChainId, address indexed recipient, uint256 amount, bytes32 srcRef);
    event YieldHarvested(address indexed beneficiary, uint256 amount);

    // --- errors ------------------------------------------------------------
    error ZeroAddress();
    error ZeroAmount();
    error AssetMismatch();
    error MessageAlreadyConsumed(bytes32 messageHash);
    error QuorumNotMet();
    error WrongSourceChain(uint256 got, uint256 expected);
    error DailyCapExceeded(uint256 cap, uint256 wouldBe);
    error NoBeneficiary();
    error NoYield();
    error PrincipalShortfall(uint256 totalAssets, uint256 principal);

    /// @param unpauseDelay_ timelock (seconds) before a proposed unpause can execute.
    /// @param admin_ DEFAULT_ADMIN_ROLE + GUARDIAN_ROLE.
    /// @param asset_ the single bridged token.
    /// @param strategy_ the yield source (its asset() must equal asset_).
    /// @param validatorSet_ the attestation authority.
    /// @param remoteChainId_ EVM chain id of the linked remote network.
    constructor(
        uint256 unpauseDelay_,
        address admin_,
        address asset_,
        address strategy_,
        address validatorSet_,
        uint256 remoteChainId_
    ) PausableGuardian(unpauseDelay_, admin_) {
        if (admin_ == address(0) || asset_ == address(0) || strategy_ == address(0) || validatorSet_ == address(0)) {
            revert ZeroAddress();
        }
        if (remoteChainId_ == 0) revert ZeroAmount();
        if (IYieldStrategy(strategy_).asset() != asset_) revert AssetMismatch();
        asset = IERC20(asset_);
        strategy = IYieldStrategy(strategy_);
        validatorSet = IBridgeValidatorSet(validatorSet_);
        remoteChainId = remoteChainId_;
    }

    // =======================================================================
    //                          ADMIN CONFIG
    // =======================================================================

    function setYieldBeneficiary(address beneficiary) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (beneficiary == address(0)) revert ZeroAddress();
        yieldBeneficiary = beneficiary;
        emit YieldBeneficiarySet(beneficiary);
    }

    function setDailyCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dailyCap = cap;
        emit DailyCapSet(cap);
    }

    // =======================================================================
    //                       OUTBOUND (user -> bridge)
    // =======================================================================

    /// @notice Lock `amount` of `asset` for bridging; the principal is deposited into the yield
    ///         strategy. Emits a cross-chain message for relay.
    function bridgeOut(uint256 amount, bytes32 destinationRef)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 nonce, bytes32 messageHash)
    {
        if (amount == 0) revert ZeroAmount();

        nonce = outboundNonce++;

        // Pull principal in, then deploy it to the strategy.
        asset.safeTransferFrom(msg.sender, address(this), amount);
        principal += amount;
        asset.forceApprove(address(strategy), amount);
        strategy.deposit(amount);

        messageHash = _digest(block.chainid, msg.sender, amount, destinationRef, nonce);
        emit BridgeLocked(messageHash, nonce, msg.sender, amount, destinationRef);
    }

    // =======================================================================
    //                    INBOUND (attested message -> user)
    // =======================================================================

    /// @notice Release `amount` of `asset` to `recipient` against an attested remote message.
    ///         Pulls the principal back out of the strategy. Permissionless to submit; gated by a
    ///         validator-set quorum and per-message replay protection.
    function bridgeIn(
        uint256 srcChainId,
        address recipient,
        uint256 amount,
        bytes32 srcRef,
        uint256 nonce,
        bytes[] calldata sigs
    ) external whenNotPaused nonReentrant {
        if (srcChainId != remoteChainId) revert WrongSourceChain(srcChainId, remoteChainId);
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        bytes32 messageHash = _digest(srcChainId, recipient, amount, srcRef, nonce);
        if (consumedMessage[messageHash]) revert MessageAlreadyConsumed(messageHash);
        if (!validatorSet.verifySignatures(messageHash, sigs)) revert QuorumNotMet();

        consumedMessage[messageHash] = true;
        _accountDailyCap(amount);

        // Reduce principal owed, then pull exactly `amount` out of the strategy to the recipient.
        // (amount <= principal must hold; underflow here = an over-release bug surfaced loudly.)
        principal -= amount;
        strategy.withdraw(amount, recipient);

        emit BridgeReleased(messageHash, srcChainId, recipient, amount, srcRef);
    }

    // =======================================================================
    //                            YIELD HARVEST
    // =======================================================================

    /// @notice Skim accrued yield (strategy surplus above `principal`) to the beneficiary. Principal
    ///         is never touched. Callable by anyone (the destination is fixed to `yieldBeneficiary`).
    /// @return harvested the amount sent to the beneficiary.
    function harvest() external nonReentrant returns (uint256 harvested) {
        address beneficiary = yieldBeneficiary;
        if (beneficiary == address(0)) revert NoBeneficiary();

        uint256 total = strategy.totalAssets();
        if (total < principal) revert PrincipalShortfall(total, principal);
        harvested = total - principal;
        if (harvested == 0) revert NoYield();

        // Withdraw only the surplus; principal stays deployed and 1:1 redeemable.
        strategy.withdraw(harvested, beneficiary);
        emit YieldHarvested(beneficiary, harvested);
    }

    /// @notice The current harvestable yield (surplus above principal), 0 if none / shortfall.
    function pendingYield() external view returns (uint256) {
        uint256 total = strategy.totalAssets();
        return total > principal ? total - principal : 0;
    }

    // =======================================================================
    //                            VIEWS / INTERNAL
    // =======================================================================

    function computeMessageHash(
        uint256 srcChainId,
        address party,
        uint256 amount,
        bytes32 ref,
        uint256 nonce
    ) external view returns (bytes32) {
        return _digest(srcChainId, party, amount, ref, nonce);
    }

    function _digest(uint256 srcChainId, address party, uint256 amount, bytes32 ref, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN, address(this), srcChainId, address(asset), party, amount, ref, nonce));
    }

    function _accountDailyCap(uint256 amount) internal {
        uint256 cap = dailyCap;
        if (block.timestamp >= windowStart + DAY) {
            windowStart = block.timestamp;
            releasedInWindow = 0;
        }
        uint256 wouldBe = releasedInWindow + amount;
        if (cap != 0 && wouldBe > cap) revert DailyCapExceeded(cap, wouldBe);
        releasedInWindow = wouldBe;
    }
}
