// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PeggedSwapPool
/// @notice A constant-SUM AMM for two tokens assumed to trade 1:1 (e.g. a coin and its
///         pegged/wrapped representation). Swaps pay out 1:1 minus a basis-point fee.
///         LP shares are minted as the sum of deposited amounts; reserves are tracked
///         internally. Accrued fees stay in the pool and are shared among LPs on exit.
contract PeggedSwapPool {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint256 public immutable feeBps;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesBurned);
    event Swap(address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 token0_, IERC20 token1_, uint256 feeBps_) {
        require(address(token0_) != address(0) && address(token1_) != address(0), "zero token");
        require(address(token0_) != address(token1_), "identical tokens");
        require(feeBps_ < BPS, "fee too high");
        token0 = token0_;
        token1 = token1_;
        feeBps = feeBps_;
    }

    /// @notice Deposit both tokens; mints LP shares equal to amount0 + amount1.
    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 minted) {
        minted = amount0 + amount1;
        require(minted > 0, "zero liquidity");

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        reserve0 += amount0;
        reserve1 += amount1;
        totalShares += minted;
        shares[msg.sender] += minted;

        emit LiquidityAdded(msg.sender, amount0, amount1, minted);
    }

    /// @notice Swap token0 in for token1 out at 1:1 minus fee.
    function swap0for1(uint256 amountIn) external returns (uint256 amountOut) {
        amountOut = _swap(token0, token1, amountIn, true);
    }

    /// @notice Swap token1 in for token0 out at 1:1 minus fee.
    function swap1for0(uint256 amountIn) external returns (uint256 amountOut) {
        amountOut = _swap(token1, token0, amountIn, false);
    }

    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, bool zeroForOne)
        private
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "zero input");
        uint256 fee = (amountIn * feeBps) / BPS;
        amountOut = amountIn - fee;

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        if (zeroForOne) {
            require(reserve1 >= amountOut, "insufficient reserve");
            // full amountIn (incl. fee) stays as reserve0; only amountOut leaves reserve1
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            require(reserve0 >= amountOut, "insufficient reserve");
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }

        tokenOut.safeTransfer(msg.sender, amountOut);
        emit Swap(msg.sender, zeroForOne, amountIn, amountOut);
    }

    /// @notice Burn shares and receive a proportional cut of both reserves (fees included).
    function removeLiquidity(uint256 sharesToBurn)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        require(sharesToBurn > 0, "zero shares");
        uint256 userShares = shares[msg.sender];
        require(userShares >= sharesToBurn, "insufficient shares");

        uint256 supply = totalShares;
        amount0 = (reserve0 * sharesToBurn) / supply;
        amount1 = (reserve1 * sharesToBurn) / supply;

        shares[msg.sender] = userShares - sharesToBurn;
        totalShares = supply - sharesToBurn;
        reserve0 -= amount0;
        reserve1 -= amount1;

        if (amount0 > 0) token0.safeTransfer(msg.sender, amount0);
        if (amount1 > 0) token1.safeTransfer(msg.sender, amount1);

        emit LiquidityRemoved(msg.sender, amount0, amount1, sharesToBurn);
    }
}
