// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PullPaymentsBase} from "../lib/PullPayment.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Demo of {PullPaymentsBase}: a 2-payee even splitter. Incoming native (via {splitNative})
///         or ERC-20 (via {splitToken}) is credited 50/50 to two payees, who then pull their share
///         with {withdrawPayments} / {withdrawTokenPayments}. Test-only usage example.
contract DemoPullSplitter is PullPaymentsBase {
    using SafeERC20 for IERC20;

    address public immutable payeeA;
    address public immutable payeeB;

    constructor(address payeeA_, address payeeB_) {
        payeeA = payeeA_;
        payeeB = payeeB_;
    }

    /// @notice Escrow incoming native value, split evenly between the two payees.
    function splitNative() external payable {
        uint256 half = msg.value / 2;
        _asyncTransfer(payeeA, half);
        _asyncTransfer(payeeB, msg.value - half); // remainder to B (handles odd wei)
    }

    /// @notice Pull `amount` of `token` from the caller, then escrow it 50/50 for the payees.
    function splitToken(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 half = amount / 2;
        _asyncTransferToken(token, payeeA, half);
        _asyncTransferToken(token, payeeB, amount - half);
    }
}
