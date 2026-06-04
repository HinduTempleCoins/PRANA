// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBurnStakeRegistry — Proof-of-Burn PERMA-stake surface.
/// @notice Burning a token records a PERMANENT, non-withdrawable stake-weight ∝ amount burned.
///         There is NO unstake, ever — the principal is destroyed, the weight is a ledger record.
///         Weight feeds (a) the ledger's BURN lane emission share and (b) governance (via an
///         IVotes adapter). Capture-resistant: a burned stake cannot be borrowed or flash-loaned.
interface IBurnStakeRegistry {
    event Burned(address indexed account, address indexed token, uint256 amount, uint256 weightAdded);

    /// @notice Permanent stake-weight of `account`.
    function weightOf(address account) external view returns (uint256);

    /// @notice Sum of all accounts' permanent weight.
    function totalWeight() external view returns (uint256);

    /// @notice Record a burn that already happened (or pull+burn) crediting `weightAdded` to
    ///         `account`. Gated to BURNER role (the MultiCurrencyBurnRouter), which normalizes
    ///         cross-currency amounts to a common weight unit before calling.
    function recordBurnWeight(address account, address token, uint256 amount, uint256 weightAdded) external;
}
