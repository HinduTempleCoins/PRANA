// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IEnergyGasAccountant — staked, regenerating energy gas model
/// @notice External surface of the energy accountant: stake a token to receive a regenerating
///         energy budget, then spend energy to perform actions.
interface IEnergyGasAccountant {
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Spent(address indexed user, uint256 amount);

    function stakeToken() external view returns (address);
    function energyPerStakePerSecond() external view returns (uint256);
    function maxEnergyPerStake() external view returns (uint256);
    function accounts(address user) external view returns (uint256 staked, uint256 energy, uint64 last);

    /// @notice Current energy of `user` (accounts for regen since last touch).
    function energyOf(address user) external view returns (uint256);

    /// @notice Energy refilled per second at the user's current stake.
    function regenRatePerSecond(address user) external view returns (uint256);

    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;

    /// @notice Spend `amount` energy (called by a gas-sponsor/relayer integrated with this meter).
    function spend(uint256 amount) external;
}
