// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IHathorFeeController — read/governed surface for the Hathor protocol-fee collection vault.
/// @notice Destination for the settlement-fee skim ({SettlementFeeHook}). It is a PASSIVE collection
///         vault: it accumulates protocol fees and NEVER trades or market-makes. The only outflow
///         path is `withdraw*`, gated to `GOVERNOR_ROLE` (intended holder: the DAO timelock), so every
///         disbursement is governed and on-chain. Front-ends and the DAO read `balanceERC20()` to show
///         treasury holdings; consuming contracts hold this handle to push fees in (via plain transfer)
///         and, under governance, pull them out. Implemented by {HathorFeeTreasury}.
interface IHathorFeeController {
    /// @notice The role permitted to disburse — intended to be held by the DAO timelock.
    /// @dev The vault's collection/disbursement events (Received / WithdrawnERC20 / WithdrawnNative)
    ///      are declared on the implementation ({HathorFeeTreasury}); they are intentionally not
    ///      redeclared here to avoid a duplicate-event collision when the vault inherits this.
    function GOVERNOR_ROLE() external view returns (bytes32);

    /// @notice The vault's current balance of `token` (what the treasury holds of that ERC-20).
    function balanceERC20(IERC20 token) external view returns (uint256);

    /// @notice Governed ERC-20 disbursement to `to`. Restricted to `GOVERNOR_ROLE`.
    function withdrawERC20(IERC20 token, address to, uint256 amount) external;

    /// @notice Governed native disbursement to `to`. Restricted to `GOVERNOR_ROLE`.
    function withdrawNative(address payable to, uint256 amount) external;
}
