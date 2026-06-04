// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDelegationMint — delegate a stake token to earn newly-minted rewards (MasterChef accrual).
/// @notice External surface of {DelegationMint}: delegate/undelegate a stake token and claim a
///         per-block emission split pro-rata to delegated share, using the classic
///         `accRewardPerShare` accumulator. The implementation must hold the minter role on the
///         reward token.
interface IDelegationMint {
    event Delegated(address indexed user, uint256 amount, uint256 newAmount);
    event Undelegated(address indexed user, uint256 amount, uint256 newAmount);
    event Claimed(address indexed user, uint256 amount);

    function stakeToken() external view returns (address);
    function rewardToken() external view returns (address);
    function emissionPerBlock() external view returns (uint256);
    function totalDelegated() external view returns (uint256);
    function accRewardPerShare() external view returns (uint256);
    function lastRewardBlock() external view returns (uint256);
    function delegations(address user)
        external
        view
        returns (uint256 amount, uint256 rewardDebt, uint256 pending);

    // --- views ------------------------------------------------------------ //
    function pendingAccPerShare() external view returns (uint256);
    function pendingReward(address user) external view returns (uint256);
    function delegatedOf(address user) external view returns (uint256);

    // --- mutators --------------------------------------------------------- //
    function delegate(uint256 amount) external;
    function undelegate(uint256 amount) external;
    function claim() external returns (uint256 reward);
}
