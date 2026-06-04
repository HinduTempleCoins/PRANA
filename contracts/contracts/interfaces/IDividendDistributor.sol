// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDividendDistributor — stake an equity token, earn a share of distributed fees
/// @notice External surface of the dividend distributor (Synthetix accumulator pattern).
interface IDividendDistributor {
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Distributed(address indexed from, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    function shareToken() external view returns (address);
    function rewardToken() external view returns (address);
    function totalShares() external view returns (uint256);
    function accRewardPerShare() external view returns (uint256);
    function shares(address user) external view returns (uint256);
    function rewardDebt(address user) external view returns (uint256);
    function pending(address user) external view returns (uint256);

    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;

    /// @notice Push `amount` of reward token to be split across current stakers.
    function distribute(uint256 amount) external;

    function claimable(address u) external view returns (uint256);
    function claim() external returns (uint256 amount);
}
