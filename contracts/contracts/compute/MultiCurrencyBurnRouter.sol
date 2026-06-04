// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBurnStakeRegistry} from "../interfaces/IBurnStakeRegistry.sol";
import {IBurnStakePriceSource} from "../interfaces/IBurnStakePriceSource.sol";

/// @dev Minimal {ERC20Burnable} surface — pull-then-burn of a wrapped ecosystem token.
interface IERC20BurnableLike {
    function burn(uint256 amount) external;
}

/// @title MultiCurrencyBurnRouter — the "Burn Coin Wallet" one-click burn-to-mine router.
///
/// @notice Accepts native PRANA OR an admin-allowlisted wrapped ecosystem ERC-20 (wMELEK / wVKBT /
///         CURE / SMTs), BURNS it, and credits PRICE-NORMALIZED permanent weight to the burner in
///         the {IBurnStakeRegistry}. Burning $X of any allowlisted currency credits the same
///         PRANA-weight as burning $X of PRANA (per the configured {IBurnStakePriceSource}). This
///         turns every ecosystem token into a deflationary SINK and an on-ramp into PRANA mining —
///         PRANA becomes the hub value flows into.
///
/// @dev    Burn mechanics:
///           - Native PRANA: sent in as `msg.value` with `token == NATIVE`. Native cannot reduce a
///             token totalSupply, so it is sunk to the canonical dead address `0x..dEaD`
///             (irrecoverable). It still counts as a permanent destruction of the burner's PRANA.
///           - Wrapped ERC-20: pulled via {SafeERC20-safeTransferFrom} (caller must approve), then
///             {IERC20Burnable.burn} reduces totalSupply — a true supply sink.
///
///         Weight = `priceSource.weightOf(token, amount)`. The price source is admin-configured and
///         currency-agnostic; see {FixedRatioPriceSource} (safe default) and
///         {OracleBurnStakePriceSource}.
///
///         ALLOWLIST / TRUST MODEL: an admin (`DEFAULT_ADMIN_ROLE`, intended to be the DAO/timelock)
///         decides WHICH currencies are admitted via {setCurrencyAllowed}. Only allowlisted wrapped
///         tokens — plus native PRANA, which is always admissible — can be burned for weight. This
///         is the policy lever for the open user decision "which currencies are admitted." Each
///         wrapped token additionally inherits the STAGE-2 single-custodian bridge trust posture of
///         {WrappedEcosystemToken}.
contract MultiCurrencyBurnRouter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Sentinel address representing native PRANA (always admissible; not in the allowlist).
    address public constant NATIVE = address(0);

    /// @notice Canonical dead address used to sink native PRANA (native supply can't be reduced).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The permanent-weight ledger credited on each burn.
    IBurnStakeRegistry public immutable registry;

    /// @notice The currency-agnostic value→PRANA-weight normalizer.
    IBurnStakePriceSource public priceSource;

    /// @notice Wrapped ERC-20s admitted to burn-to-mine (NATIVE is always admitted, not tracked here).
    mapping(address => bool) public currencyAllowed;

    event PriceSourceSet(address indexed priceSource);
    event CurrencyAllowed(address indexed token, bool allowed);
    event BurnedToMine(
        address indexed account,
        address indexed token,
        uint256 amount,
        uint256 weightAdded,
        bool nativeSink
    );

    error ZeroAmount();
    error CurrencyNotAllowed(address token);
    error NativeAmountMismatch(uint256 sent, uint256 amount);
    error UnexpectedNativeValue();
    error ZeroAddress();
    error ZeroWeight();

    /// @param admin        DEFAULT_ADMIN_ROLE — manages the allowlist + price source (DAO/timelock).
    /// @param registry_    The {IBurnStakeRegistry} this router records into (must grant it BURNER).
    /// @param priceSource_ Initial {IBurnStakePriceSource} (default to {FixedRatioPriceSource}).
    constructor(address admin, IBurnStakeRegistry registry_, IBurnStakePriceSource priceSource_) {
        if (admin == address(0) || address(registry_) == address(0) || address(priceSource_) == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        registry = registry_;
        priceSource = priceSource_;
        emit PriceSourceSet(address(priceSource_));
    }

    // =======================================================================
    //                              ADMIN
    // =======================================================================

    /// @notice Swap the value→weight normalizer (e.g. move a currency from fixed-ratio to oracle).
    function setPriceSource(IBurnStakePriceSource priceSource_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(priceSource_) == address(0)) revert ZeroAddress();
        priceSource = priceSource_;
        emit PriceSourceSet(address(priceSource_));
    }

    /// @notice Admit (or revoke) a wrapped ecosystem token for burn-to-mine. NATIVE is implicit.
    function setCurrencyAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == NATIVE) revert ZeroAddress(); // native is always allowed; don't allowlist it
        currencyAllowed[token] = allowed;
        emit CurrencyAllowed(token, allowed);
    }

    // =======================================================================
    //                            BURN-TO-MINE
    // =======================================================================

    /// @notice One-click burn-to-mine. Burns `amount` of `token` (native PRANA if `token == NATIVE`,
    ///         else an allowlisted wrapped ERC-20) and credits normalized weight to the caller.
    /// @param token  NATIVE (address(0)) for PRANA, else an allowlisted wrapped ERC-20.
    /// @param amount Base-unit amount to burn. For NATIVE this MUST equal `msg.value`.
    /// @return weightAdded The PRANA-weight credited to the caller.
    function burnToMine(address token, uint256 amount)
        external
        payable
        nonReentrant
        returns (uint256 weightAdded)
    {
        if (amount == 0) revert ZeroAmount();

        bool nativeSink;
        if (token == NATIVE) {
            // Native PRANA path: msg.value must match; sink to dead address (irrecoverable).
            if (msg.value != amount) revert NativeAmountMismatch(msg.value, amount);
            nativeSink = true;
            (bool ok, ) = DEAD.call{value: amount}("");
            require(ok, "native sink failed");
        } else {
            // Wrapped ERC-20 path: no native value expected; must be allowlisted.
            if (msg.value != 0) revert UnexpectedNativeValue();
            if (!currencyAllowed[token]) revert CurrencyNotAllowed(token);
            // Pull then burn — reduces totalSupply (true supply sink).
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            IERC20BurnableLike(token).burn(amount);
        }

        // Normalize the burned amount to PRANA-weight. Price source fails closed on unpriced tokens.
        weightAdded = priceSource.weightOf(token, amount);
        if (weightAdded == 0) revert ZeroWeight();

        // Record the permanent, non-withdrawable stake-weight.
        registry.recordBurnWeight(msg.sender, token, amount, weightAdded);

        emit BurnedToMine(msg.sender, token, amount, weightAdded, nativeSink);
    }
}
