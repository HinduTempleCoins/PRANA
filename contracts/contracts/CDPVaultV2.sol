// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IMintable} from "./BurnMine.sol";
import {SimplePriceOracle} from "./SimplePriceOracle.sol";
import {CDPVault} from "./CDPVault.sol";

/// @title CDPVaultV2 — CDPVault plus the trusted liquidation hooks an external engine drives.
/// @notice The base CDPVault only supports a coarse self-`liquidate()` (full debt, full collateral,
///         no bonus). CDPVaultV2 inherits the base unchanged and adds the minimal hook surface
///         (ICDPVaultLiquidatable) so a CollateralLiquidationEngine can perform Aave-style PARTIAL
///         liquidations with a configurable close factor and liquidation bonus while keeping all
///         policy/pricing in the engine. The base `liquidate()` is left in place and still works.
/// @dev CDPVault.sol is intentionally NOT modified — other deployments/tests depend on it. This
///      contract only ADDS state (`liquidationEngine`) and the three trusted hooks. Hooks are gated
///      to a single immutable engine address (not an open call), and they only move tokens the vault
///      alone controls (it custodies collateral and holds the debt token's minter/burn rights).
///      NOTE: implements the ICDPVaultLiquidatable ABI *without* inheriting the interface — the
///      base vault's public `collateralOf`/`debtOf` state-variable getters cannot legally override
///      interface functions in Solidity, but external callers (the engine) bind by ABI, not by type.
contract CDPVaultV2 is CDPVault {
    using SafeERC20 for IERC20;

    /// @notice Deployer permitted to wire the engine once.
    address public immutable admin;
    /// @notice The only address allowed to call the liquidation hooks. Set once, then locked.
    address public liquidationEngine;

    event LiquidationEngineSet(address indexed engine);
    event LiquidationRepaid(address indexed user, address indexed payer, uint256 amount);
    event LiquidationSeized(address indexed user, address indexed recipient, uint256 amount);
    event LiquidationWrittenOff(address indexed user, uint256 amount);

    error NotAdmin();
    error EngineAlreadySet();
    error NotLiquidationEngine();
    error AmountZero();
    error ExceedsDebt();
    error ExceedsCollateral();

    /// @dev The engine and the vault reference each other, so the engine address cannot be known at
    ///      vault construction. It is wired once, post-deploy, via `setLiquidationEngine` and then
    ///      permanently locked (the engine cannot be swapped, preserving the trust assumption).
    constructor(
        IERC20 collateral_,
        IMintable debtToken_,
        SimplePriceOracle oracle_,
        uint256 maxLTV_,
        address admin_
    ) CDPVault(collateral_, debtToken_, oracle_, maxLTV_) {
        require(admin_ != address(0), "admin=0");
        admin = admin_;
    }

    /// @notice Wire the liquidation engine exactly once. Callable only by `admin`.
    function setLiquidationEngine(address engine) external {
        if (msg.sender != admin) revert NotAdmin();
        if (liquidationEngine != address(0)) revert EngineAlreadySet();
        require(engine != address(0), "engine=0");
        liquidationEngine = engine;
        emit LiquidationEngineSet(engine);
    }

    modifier onlyEngine() {
        if (msg.sender != liquidationEngine) revert NotLiquidationEngine();
        _;
    }

    /// @notice See ICDPVaultLiquidatable (ABI implemented without inheritance — see contract NatSpec).
    function liquidationRepay(address user, address payer, uint256 repayAmount) external onlyEngine {
        if (repayAmount == 0) revert AmountZero();
        if (repayAmount > debtOf[user]) revert ExceedsDebt();
        // Pull the debt token from the payer (the liquidator) and burn it, mirroring repay().
        IERC20(address(debtToken)).safeTransferFrom(payer, address(this), repayAmount);
        ERC20Burnable(address(debtToken)).burn(repayAmount);
        debtOf[user] -= repayAmount;
        emit LiquidationRepaid(user, payer, repayAmount);
    }

    /// @notice See ICDPVaultLiquidatable (ABI implemented without inheritance — see contract NatSpec).
    function liquidationSeize(address user, address recipient, uint256 seizeAmount) external onlyEngine {
        if (seizeAmount == 0) revert AmountZero();
        if (seizeAmount > collateralOf[user]) revert ExceedsCollateral();
        collateralOf[user] -= seizeAmount;
        collateral.safeTransfer(recipient, seizeAmount);
        emit LiquidationSeized(user, recipient, seizeAmount);
    }

    /// @notice See ICDPVaultLiquidatable (ABI implemented without inheritance — see contract NatSpec).
    function liquidationWriteOff(address user, uint256 amount) external onlyEngine {
        if (amount == 0) revert AmountZero();
        if (amount > debtOf[user]) revert ExceedsDebt();
        debtOf[user] -= amount;
        emit LiquidationWrittenOff(user, amount);
    }
}
