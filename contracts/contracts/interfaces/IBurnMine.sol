// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBurnMine — fixed-ratio burn-to-mint interface
/// @notice External surface of a burn-mine: pull in an input token, burn it, and mint an
///         output token at a fixed ratio. Modules can compose against this interface.
interface IBurnMine {
    event Mined(address indexed who, uint256 amountIn, uint256 amountOut);

    function input() external view returns (address);
    function output() external view returns (address);
    function ratioNum() external view returns (uint256);
    function ratioDen() external view returns (uint256);
    function totalBurned() external view returns (uint256);
    function totalMinted() external view returns (uint256);

    /// @notice Preview the output for a given input without state change.
    function quote(uint256 amountIn) external view returns (uint256);

    /// @notice Burn `amountIn` of the input token; mint the ratio'd amount of the output to caller.
    function mine(uint256 amountIn) external returns (uint256 amountOut);
}
