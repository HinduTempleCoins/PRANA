// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ICDPVault — minimal overcollateralized lending (Maker/Aave model)
/// @notice External surface of the CDP vault: deposit collateral, borrow a mintable debt token,
///         repay, withdraw, and liquidate unhealthy positions.
interface ICDPVault {
    event Deposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);

    function collateral() external view returns (address);
    function debtToken() external view returns (address);
    function oracle() external view returns (address);
    function maxLTV() external view returns (uint256);
    function collateralOf(address user) external view returns (uint256);
    function debtOf(address user) external view returns (uint256);

    function collateralValue(address user) external view returns (uint256);
    function maxBorrow(address user) external view returns (uint256);

    /// @notice Health factor scaled 1e18; < 1e18 means liquidatable.
    function healthFactor(address user) external view returns (uint256);

    function deposit(uint256 amount) external;
    function borrow(uint256 amount) external;
    function repay(uint256 amount) external;
    function withdraw(uint256 amount) external;

    /// @notice Liquidate an unhealthy position: repay its full debt, seize all its collateral.
    function liquidate(address user) external;
}
