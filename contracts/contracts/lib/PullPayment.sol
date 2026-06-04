// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PullPaymentsBase — OZ-style pull payments with an in-contract escrow ledger
/// @notice "Push" payments (sending value inline) hand control to the payee mid-transaction and
///         can be griefed (a reverting/expensive payee blocks the whole flow) or used as a
///         re-entrancy vector. The pull pattern instead CREDITS the payee an internal balance
///         (`_asyncTransfer`) and lets them WITHDRAW it themselves (`withdrawPayments`).
///
/// @dev    Unlike OZ's PullPayment (which delegates to a separate `Escrow` contract), this keeps
///         the escrow as an internal mapping — simpler, fewer deployments, one less external
///         call. Withdrawals are re-entrancy-safe via the checks-effects-interactions order:
///         the credited amount is ZEROED *before* the external send, so a re-entrant withdraw
///         finds a zero balance and cannot double-pay. Native sends use a low-level call (works
///         for contract payees); ERC-20 uses SafeERC20.
abstract contract PullPaymentsBase {
    using SafeERC20 for IERC20;

    // payee => owed native wei
    mapping(address => uint256) private _nativePayments;
    // token => payee => owed token amount
    mapping(address => mapping(address => uint256)) private _tokenPayments;

    event NativePaymentEscrowed(address indexed payee, uint256 amount);
    event NativePaymentWithdrawn(address indexed payee, uint256 amount);
    event TokenPaymentEscrowed(address indexed token, address indexed payee, uint256 amount);
    event TokenPaymentWithdrawn(address indexed token, address indexed payee, uint256 amount);

    error ZeroPayee();
    error NoPayment();
    error NativeSendFailed();

    // ---------------------------------------------------------------------
    // Native
    // ---------------------------------------------------------------------

    /// @notice Native balance currently owed to (withdrawable by) `payee`.
    function payments(address payee) public view returns (uint256) {
        return _nativePayments[payee];
    }

    /// @dev Credit `payee` `amount` native wei to be pulled later. Callers must ensure the
    ///      contract actually holds/receives this value (e.g. forward `msg.value`).
    function _asyncTransfer(address payee, uint256 amount) internal {
        if (payee == address(0)) revert ZeroPayee();
        _nativePayments[payee] += amount;
        emit NativePaymentEscrowed(payee, amount);
    }

    /// @notice Withdraw all native funds owed to `payee` (anyone may trigger; funds only ever go
    ///         to `payee`). Re-entrancy-safe: balance zeroed before the send.
    function withdrawPayments(address payable payee) public {
        uint256 amount = _nativePayments[payee];
        if (amount == 0) revert NoPayment();
        _nativePayments[payee] = 0; // effects before interaction
        (bool ok, ) = payee.call{value: amount}("");
        if (!ok) revert NativeSendFailed();
        emit NativePaymentWithdrawn(payee, amount);
    }

    // ---------------------------------------------------------------------
    // ERC-20
    // ---------------------------------------------------------------------

    /// @notice ERC-20 balance of `token` currently owed to (withdrawable by) `payee`.
    function tokenPayments(address token, address payee) public view returns (uint256) {
        return _tokenPayments[token][payee];
    }

    /// @dev Credit `payee` `amount` of `token` to be pulled later. Callers must ensure the
    ///      contract holds the corresponding token balance.
    function _asyncTransferToken(address token, address payee, uint256 amount) internal {
        if (payee == address(0)) revert ZeroPayee();
        _tokenPayments[token][payee] += amount;
        emit TokenPaymentEscrowed(token, payee, amount);
    }

    /// @notice Withdraw all of `token` owed to `payee`. Re-entrancy-safe: balance zeroed before
    ///         the transfer (also defends against ERC-777/callback-style hostile tokens).
    function withdrawTokenPayments(address token, address payee) public {
        uint256 amount = _tokenPayments[token][payee];
        if (amount == 0) revert NoPayment();
        _tokenPayments[token][payee] = 0; // effects before interaction
        IERC20(token).safeTransfer(payee, amount);
        emit TokenPaymentWithdrawn(token, payee, amount);
    }
}
