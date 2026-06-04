// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Callee} from "../interfaces/IUniswapV2Callee.sol";
import {UniswapV2Library} from "../UniswapV2Router.sol";

interface IERC20FlashMinimal {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title FlashSwapExample
/// @notice Minimal demonstration of a Uniswap V2 flash swap against our 0.8.24 pair port.
///         The pair optimistically sends the requested output, then calls `uniswapV2Call`;
///         this contract does something trivial with the borrowed tokens and repays the same
///         token plus the 0.3% fee, leaving the pair's x*y=k invariant satisfied.
/// @dev Repaying in the SAME token the borrow is denominated in (not swapping to the other
///      side) is the simplest correct flash-swap: the pair only requires that the post-call
///      balances keep k from decreasing, which `amountBorrowed * 1000 / 997 + 1` covers.
contract FlashSwapExample is IUniswapV2Callee {
    address public immutable factory;

    /// @notice Set true by the callback so tests can assert the borrowed funds were received.
    bool public flashReceived;
    uint256 public lastAmountBorrowed;
    uint256 public lastFeePaid;

    constructor(address _factory) {
        factory = _factory;
    }

    /// @notice Kick off a flash borrow of `amount` of `borrowToken` from its pair with `otherToken`.
    function startFlashSwap(address borrowToken, address otherToken, uint256 amount) external {
        address pairAddr = UniswapV2Library.pairFor(factory, borrowToken, otherToken);
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        (address token0, ) = UniswapV2Library.sortTokens(borrowToken, otherToken);
        (uint256 amount0Out, uint256 amount1Out) = borrowToken == token0
            ? (amount, uint256(0))
            : (uint256(0), amount);
        // non-empty data triggers the uniswapV2Call callback (flash-swap mode)
        pair.swap(amount0Out, amount1Out, address(this), abi.encode(borrowToken, amount));
    }

    /// @inheritdoc IUniswapV2Callee
    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external override {
        // Only an actual pair created by our factory may invoke this callback.
        address token0 = IUniswapV2Pair(msg.sender).token0();
        address token1 = IUniswapV2Pair(msg.sender).token1();
        require(msg.sender == UniswapV2Library.pairFor(factory, token0, token1), "FlashSwap: NOT_PAIR");
        require(sender == address(this), "FlashSwap: NOT_SELF");

        (address borrowToken, uint256 amountBorrowed) = abi.decode(data, (address, uint256));
        uint256 borrowed = amount0 > 0 ? amount0 : amount1;
        require(borrowed == amountBorrowed, "FlashSwap: AMOUNT_MISMATCH");

        flashReceived = true;
        lastAmountBorrowed = borrowed;

        // ---- trivial "use" of the borrowed funds would go here ----

        // Repay borrowed + 0.3% fee, in the same token: amountIn must satisfy
        // amountIn * 997 >= borrowed * 1000  =>  amountIn = ceil(borrowed * 1000 / 997).
        uint256 repay = (borrowed * 1000) / 997 + 1;
        lastFeePaid = repay - borrowed;
        require(IERC20FlashMinimal(borrowToken).transfer(msg.sender, repay), "FlashSwap: REPAY_FAILED");
    }

    /// @notice Test helper: fund this contract so it can pay the flash fee.
    function rescue(address token, address to, uint256 amount) external {
        IERC20FlashMinimal(token).transfer(to, amount);
    }
}
