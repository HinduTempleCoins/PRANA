// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IYieldStrategy — pluggable yield source for idle bridge TVL.
///
/// @notice Injected into {YieldBearingBridgeVault} (BI6, gated by UD-BI-F). The vault deposits locked
///         principal here so it earns yield instead of sitting idle, while the principal stays 1:1
///         redeemable. The strategy wraps an external venue (an ERC-4626 vault, a lending market, a
///         staking router, …) behind one selector set so it is swappable without touching the vault.
///
/// @dev    Accounting contract: `totalAssets()` MUST be monotonic-with-yield for a given principal —
///         i.e. `totalAssets() >= sum(deposit) - sum(withdraw)` so the vault can always redeem
///         principal 1:1 and skim only the surplus as yield. A strategy that can lose principal MUST
///         NOT be used here (the vault assumes principal safety; see vault NatSpec for the risk
///         disclaimer). All amounts are in the underlying token's units; the strategy holds/returns
///         the same `asset()` the vault locked.
interface IYieldStrategy {
    /// @notice The underlying token this strategy accepts and returns.
    function asset() external view returns (address);

    /// @notice Pull `amount` of {asset} from the caller (the vault) and deploy it to the yield venue.
    /// @dev    The vault MUST have approved the strategy for `amount` (or the strategy pulls via
    ///         transferFrom). Returns the amount actually deployed (== `amount` for well-behaved venues).
    function deposit(uint256 amount) external returns (uint256 deposited);

    /// @notice Withdraw `amount` of {asset} from the venue and send it to `to`.
    /// @dev    MUST be able to satisfy any `amount <= principal currently deployed` (principal is
    ///         redeemable on demand). Returns the amount actually withdrawn.
    function withdraw(uint256 amount, address to) external returns (uint256 withdrawn);

    /// @notice Total {asset} currently recoverable from the venue, including accrued yield.
    /// @dev    `totalAssets() - principalDeployed` is the harvestable surplus the vault skims.
    function totalAssets() external view returns (uint256);
}
