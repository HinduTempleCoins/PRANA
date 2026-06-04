// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV2Pair} from "../amm/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Callee} from "../amm/interfaces/IUniswapV2Callee.sol";
import {UniswapV2Library} from "../amm/UniswapV2Router.sol";

/// @title BadFlashBorrower — adversarial flash-swap borrower that never repays.
/// @notice Borrows via a flash swap and intentionally does NOT return the funds (or fee).
///         Used to prove the pair's x*y=k check in `swap` reverts the whole transaction when a
///         flash borrower fails to repay, so no value can be extracted. TEST ONLY.
contract BadFlashBorrower is IUniswapV2Callee {
    address public immutable factory;

    /// @notice If true, repay nothing at all. If false, repay short (less than borrowed+fee).
    bool public repayShort;

    constructor(address _factory) {
        factory = _factory;
    }

    function setRepayShort(bool v) external {
        repayShort = v;
    }

    function startFlashSwap(address borrowToken, address otherToken, uint256 amount) external {
        address pairAddr = UniswapV2Library.pairFor(factory, borrowToken, otherToken);
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        (address token0, ) = UniswapV2Library.sortTokens(borrowToken, otherToken);
        (uint256 amount0Out, uint256 amount1Out) = borrowToken == token0
            ? (amount, uint256(0))
            : (uint256(0), amount);
        pair.swap(amount0Out, amount1Out, address(this), abi.encode(borrowToken, amount));
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external override {
        // Deliberately repay nothing (or, if configured, an obviously-insufficient amount that
        // can never satisfy k). Either way the pair's invariant check must revert.
        if (repayShort) {
            // pay back a token dust amount is still skipped here — we simply do nothing,
            // which is the strongest proof: balances unchanged => k strictly decreases => revert.
        }
        // intentionally no transfer back to msg.sender (the pair)
    }
}
