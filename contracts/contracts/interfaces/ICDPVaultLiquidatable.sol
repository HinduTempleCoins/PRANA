// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ICDPVaultLiquidatable — the liquidation hook surface an external engine drives.
/// @notice The base CDPVault only knows how to self-liquidate (full debt, full collateral). To
///         support Aave-style partial liquidation with a configurable close factor and bonus, the
///         vault exposes two trusted hooks that an authorized liquidation engine can call to (a)
///         pull-and-burn part of a position's debt and (b) release a measured amount of collateral
///         to the liquidator. Authorization is by a single `liquidationEngine` address set once at
///         construction — NOT an open `liquidate()`. All collateral-ratio / pricing policy lives in
///         the engine; the vault only does the bookkeeping + token movements it alone can do
///         (it holds the collateral and the debt-token minter/burn rights).
interface ICDPVaultLiquidatable {
    /// @notice Engine permitted to call the liquidation hooks.
    function liquidationEngine() external view returns (address);

    /// @notice Per-user position accounting (mirrors the base vault's public mappings).
    function collateralOf(address user) external view returns (uint256);
    function debtOf(address user) external view returns (uint256);

    /// @notice Pull `repayAmount` of debt token from `payer`, burn it, and reduce `user`'s debt.
    /// @dev Only callable by `liquidationEngine`. Reverts if repayAmount > the user's debt.
    function liquidationRepay(address user, address payer, uint256 repayAmount) external;

    /// @notice Release `seizeAmount` of collateral from `user`'s position to `recipient`.
    /// @dev Only callable by `liquidationEngine`. Reverts if seizeAmount > the user's collateral.
    function liquidationSeize(address user, address recipient, uint256 seizeAmount) external;

    /// @notice Write off `amount` of `user`'s debt with no repayment (bad-debt socialization).
    /// @dev Only callable by `liquidationEngine`. Used by the insolvent-dust full-close path when a
    ///      position's collateral is exhausted but residual debt remains.
    function liquidationWriteOff(address user, uint256 amount) external;
}
