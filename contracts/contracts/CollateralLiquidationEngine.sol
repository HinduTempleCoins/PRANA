// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ICDPVaultLiquidatable} from "./interfaces/ICDPVaultLiquidatable.sol";
import {IStalePriceOracle} from "./interfaces/IStalePriceOracle.sol";

/// @title ICDPVaultView — the read surface the engine needs from the vault.
interface ICDPVaultView {
    function collateral() external view returns (address);
    function debtToken() external view returns (address);
    function maxLTV() external view returns (uint256);
    function debtOf(address user) external view returns (uint256);
    function collateralOf(address user) external view returns (uint256);
    function collateralValue(address user) external view returns (uint256);
    function healthFactor(address user) external view returns (uint256);
}

/// @title CollateralLiquidationEngine — Aave-style partial liquidation module for a CDP vault.
/// @notice When a position's health factor falls below 1 (collateral value, at LTV, no longer
///         covers its debt), a liquidator may repay up to `closeFactorBps` of the debt and seize
///         collateral worth `repaid * (1 + liquidationBonusBps)` at the oracle price — partial
///         liquidations allowed. Two safety carve-outs: (1) a DUST position (debt <= `dustThreshold`)
///         may be fully closed in one call so no uneconomic residual is stranded; (2) an INSOLVENT
///         position (collateral value < debt) is force-fully closed — the liquidator seizes all
///         remaining collateral and the unrecoverable residual debt is written off as bad debt.
/// @dev The engine holds NO funds and NO custody: it only orchestrates the vault's trusted hooks
///      (ICDPVaultLiquidatable). The vault must be deployed with this engine as its
///      `liquidationEngine`. Prices are read through a staleness-guarded oracle (IStalePriceOracle)
///      and rejected if older than `maxPriceAge`, closing the oracle-staleness gap flagged for the
///      base vault (whose plain oracle reports no timestamp).
contract CollateralLiquidationEngine {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    ICDPVaultLiquidatable public immutable vault;
    IStalePriceOracle public immutable oracle;
    address public immutable collateral;
    address public immutable debtToken;

    /// @notice Max fraction of a position's debt repayable in one call, in bps (e.g. 5000 = 50%).
    uint256 public immutable closeFactorBps;
    /// @notice Bonus collateral granted to the liquidator over the repaid value, in bps (e.g. 1000 = 10%).
    uint256 public immutable liquidationBonusBps;
    /// @notice Debt at or below this (in debt units) is treated as dust → eligible for full close.
    uint256 public immutable dustThreshold;
    /// @notice Max age (seconds) of an oracle price before it is rejected as stale.
    uint256 public immutable maxPriceAge;

    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 badDebtWrittenOff,
        bool fullClose
    );

    error PositionHealthy();
    error NoDebt();
    error RepayAmountZero();
    error StalePrice();
    error BadOraclePrice();

    constructor(
        ICDPVaultLiquidatable vault_,
        IStalePriceOracle oracle_,
        uint256 closeFactorBps_,
        uint256 liquidationBonusBps_,
        uint256 dustThreshold_,
        uint256 maxPriceAge_
    ) {
        require(address(vault_) != address(0) && address(oracle_) != address(0), "zero");
        require(closeFactorBps_ > 0 && closeFactorBps_ <= BPS, "closeFactor");
        require(liquidationBonusBps_ <= BPS, "bonus"); // <=100% bonus
        require(maxPriceAge_ > 0, "maxPriceAge");

        vault = vault_;
        oracle = oracle_;
        closeFactorBps = closeFactorBps_;
        liquidationBonusBps = liquidationBonusBps_;
        dustThreshold = dustThreshold_;
        maxPriceAge = maxPriceAge_;

        collateral = ICDPVaultView(address(vault_)).collateral();
        debtToken = ICDPVaultView(address(vault_)).debtToken();
    }

    /// @notice Fresh collateral price (scaled 1e18); reverts if non-positive or stale.
    function freshPrice() public view returns (uint256) {
        (uint256 price, uint256 updatedAt) = oracle.priceWithTimestamp(collateral);
        if (price == 0) revert BadOraclePrice();
        if (block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
        return price;
    }

    /// @dev Outcome of the liquidation sizing math, packed to keep call stacks shallow.
    struct Plan {
        uint256 repay;        // debt token pulled from & burned for the liquidator
        uint256 seize;        // collateral released to the liquidator
        uint256 writeOff;     // residual debt socialized as bad debt (insolvent path)
        bool fullClose;       // whether the whole position is being closed
    }

    /// @notice Liquidate an unhealthy position: repay (up to the close factor, or in full for a
    ///         dust/insolvent position) and seize bonus-weighted collateral. The caller (liquidator)
    ///         must have approved the VAULT (not this engine) to pull `repay` debt tokens — the
    ///         vault is what calls transferFrom inside its trusted repay hook.
    /// @param user The position owner being liquidated.
    /// @param repayAmount The debt amount the liquidator wishes to repay (capped internally).
    /// @return repaid Actual debt repaid. @return seized Actual collateral seized.
    function liquidate(address user, uint256 repayAmount) external returns (uint256 repaid, uint256 seized) {
        if (repayAmount == 0) revert RepayAmountZero();
        if (ICDPVaultView(address(vault)).healthFactor(user) >= WAD) revert PositionHealthy();

        uint256 debt = vault.debtOf(user);
        if (debt == 0) revert NoDebt();

        uint256 price = freshPrice();
        Plan memory plan = _plan(user, debt, price, repayAmount);

        // Effects via the vault's trusted hooks. Repay+burn first, then seize, then any write-off.
        if (plan.repay > 0) {
            vault.liquidationRepay(user, msg.sender, plan.repay);
        }
        if (plan.seize > 0) {
            vault.liquidationSeize(user, msg.sender, plan.seize);
        }
        if (plan.writeOff > 0) {
            vault.liquidationWriteOff(user, plan.writeOff);
        }

        emit Liquidated(user, msg.sender, plan.repay, plan.seize, plan.writeOff, plan.fullClose);
        return (plan.repay, plan.seize);
    }

    /// @dev Compute repay / seize / write-off for `user`. Pure-ish (only reads collateralOf).
    function _plan(
        address user,
        uint256 debt,
        uint256 price,
        uint256 repayAmount
    ) internal view returns (Plan memory plan) {
        uint256 col = vault.collateralOf(user);
        uint256 colValue = (col * price) / WAD;
        bool insolvent = colValue < debt;
        bool dust = debt <= dustThreshold;

        // Max repay this call allows. Dust or insolvent positions may be fully closed.
        uint256 maxRepay = (dust || insolvent) ? debt : (debt * closeFactorBps) / BPS;
        uint256 repay = repayAmount > maxRepay ? maxRepay : repayAmount;

        // Bonus-weighted collateral value the repay entitles the liquidator to, in collateral units.
        uint256 seize = _seizeForRepay(repay, price);

        // Cannot seize more than exists; if we hit the cap, the position is collateral-exhausted.
        if (seize >= col) {
            seize = col;
            // Collateral fully drained. This is a full close: socialize whatever debt the repay
            // (capped by available collateral) could not cover.
            plan.writeOff = debt - repay;
            plan.fullClose = true;
        } else {
            plan.fullClose = (repay == debt);
        }

        plan.repay = repay;
        plan.seize = seize;
    }

    /// @dev Collateral (in token units) worth `repay * (1 + bonus)` at `price` (1e18-scaled).
    function _seizeForRepay(uint256 repay, uint256 price) internal view returns (uint256) {
        // Single combined expression — dividing by BPS first would floor away the bonus
        // entirely on small repay amounts (e.g. repay 8, bonus 10% → 8 instead of 8.8).
        return (repay * (BPS + liquidationBonusBps) * WAD) / (BPS * price);
    }

    /// @notice True if `user`'s position is currently liquidatable (HF < 1).
    function isLiquidatable(address user) external view returns (bool) {
        return vault.debtOf(user) > 0 && ICDPVaultView(address(vault)).healthFactor(user) < WAD;
    }
}
