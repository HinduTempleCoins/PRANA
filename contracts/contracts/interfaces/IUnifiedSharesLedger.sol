// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IUnifiedSharesLedger — the chain-as-pool PPLNS ledger surface.
/// @notice One ledger; three lanes (HASH, TASK, BURN) credit shares into the SAME per-epoch pool
///         and are paid pro-rata from fixed per-epoch issuance over a rolling PPLNS window. Each
///         lane has its own CREDITOR role so off-chain coordinators / on-chain modules can only
///         credit their own lane. Hash and task weight EQUAL by default (the switching engine).
interface IUnifiedSharesLedger {
    enum Lane { HASH, TASK, BURN }

    event SharesCredited(uint256 indexed epoch, Lane indexed lane, address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 epoch, uint256 amount);

    /// @notice Credit `amount` shares to `account` in `lane` for the CURRENT epoch.
    /// @dev Gated to that lane's CREDITOR role. `amount` is the lane-native share count; the
    ///      ledger applies the governed lane weight (see IHashTaskWeightConfig) when pooling.
    function creditShares(address account, Lane lane, uint256 amount) external;

    /// @notice Claim an account's pro-rata payout for a fully-closed epoch (idempotent per epoch).
    function claim(uint256 epoch) external returns (uint256 paid);

    /// @notice Pro-rata amount `account` could claim for `epoch` right now (0 if open/already claimed).
    function claimable(address account, uint256 epoch) external view returns (uint256);

    function epochLength() external view returns (uint256);
    function windowEpochs() external view returns (uint256);
    function epochIssuance() external view returns (uint256);
    function totalSharesAt(uint256 epoch) external view returns (uint256);
}
