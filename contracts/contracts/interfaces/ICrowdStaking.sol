// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ICrowdStaking — NutBox-style multi-pool crowd-staking (BI11).
/// @notice External surface of {CrowdStaking}: delegate a shared power token into one of many named
///         community pools and harvest that community's pre-funded reward token pro-rata to your
///         share, using the MasterChef `accRewardPerShare` accumulator. Unlike {IDelegationMint}
///         (single pool, mints rewards), this is a registry of many pools that *transfer out*
///         pre-funded reward tokens.
interface ICrowdStaking {
    event PoolAdded(uint256 indexed pid, address indexed rewardToken, uint256 emissionPerBlock, bytes32 name);
    event EmissionRateChanged(uint256 indexed pid, uint256 oldRate, uint256 newRate);
    event Staked(uint256 indexed pid, address indexed user, uint256 amount, uint256 newAmount);
    event Unstaked(uint256 indexed pid, address indexed user, uint256 amount, uint256 newAmount);
    event Harvested(uint256 indexed pid, address indexed user, uint256 amount);

    function powerToken() external view returns (address);
    function poolCount() external view returns (uint256);
    function pools(uint256 pid)
        external
        view
        returns (
            address rewardToken,
            uint256 emissionPerBlock,
            uint256 totalStaked,
            uint256 accRewardPerShare,
            uint256 lastRewardBlock,
            bytes32 name,
            bool exists
        );
    function userInfo(uint256 pid, address user)
        external
        view
        returns (uint256 amount, uint256 rewardDebt, uint256 pending);

    // --- views ------------------------------------------------------------ //
    function pendingAccPerShare(uint256 pid) external view returns (uint256);
    function pendingReward(uint256 pid, address user) external view returns (uint256);
    function stakedOf(uint256 pid, address user) external view returns (uint256);

    // --- admin / DAO ------------------------------------------------------ //
    function addPool(address rewardToken, uint256 emissionPerBlock, bytes32 name) external returns (uint256 pid);
    function setEmissionRate(uint256 pid, uint256 emissionPerBlock) external;

    // --- mutators --------------------------------------------------------- //
    function stake(uint256 pid, uint256 amount) external;
    function unstake(uint256 pid, uint256 amount) external;
    function harvest(uint256 pid) external returns (uint256 paid);
}
