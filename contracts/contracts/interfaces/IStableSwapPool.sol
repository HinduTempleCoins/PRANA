// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IStableSwapPool — a 2-coin Curve StableSwap pool whose LP token is the pool itself.
/// @notice External surface of {StableSwapPool}: add/remove liquidity (balanced or one-coin),
///         exchange, the StableSwap invariant reads (D, virtual price, dy quote), and the admin
///         amplification-ramp / fee controls.
/// @dev The implementation IS an ERC-20 (LP shares); this interface declares only the pool-
///      specific surface on top of the standard token functions.
interface IStableSwapPool {
    event AddLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 lpMinted, uint256 invariant);
    event RemoveLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 lpBurned);
    event RemoveLiquidityOneCoin(address indexed provider, uint8 coin, uint256 amountOut, uint256 lpBurned);
    event TokenExchange(address indexed buyer, uint8 soldId, uint256 amountSold, uint8 boughtId, uint256 amountBought);
    event RampA(uint256 initialA, uint256 futureA, uint256 initialTime, uint256 futureTime);
    event StopRampA(uint256 currentA, uint256 atTime);
    event FeeUpdated(uint256 feeBps);

    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function reserve0() external view returns (uint256);
    function reserve1() external view returns (uint256);
    function feeBps() external view returns (uint256);

    // --- amplification / fee admin ---------------------------------------- //
    function getA() external view returns (uint256);
    function A() external view returns (uint256);
    function rampA(uint256 futureARaw, uint256 futureTime_) external;
    function stopRampA() external;
    function setFee(uint256 feeBps_) external;

    // --- invariant reads -------------------------------------------------- //
    function getVirtualPrice() external view returns (uint256);
    function getD() external view returns (uint256);
    function getDy(uint8 i, uint8 j, uint256 dx) external view returns (uint256 dy);
    function calcWithdrawOneCoin(uint256 lpAmount, uint8 i) external view returns (uint256);

    // --- mutators --------------------------------------------------------- //
    function exchange(uint8 i, uint8 j, uint256 dx, uint256 minDy) external returns (uint256 dy);
    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minLp) external returns (uint256 minted);
    function removeLiquidity(uint256 lpAmount, uint256 minAmount0, uint256 minAmount1)
        external
        returns (uint256 amount0, uint256 amount1);
    function removeLiquidityOneCoin(uint256 lpAmount, uint8 i, uint256 minAmount) external returns (uint256 dy);
}
