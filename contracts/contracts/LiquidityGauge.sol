// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LiquidityGauge — stake LP tokens, earn rewards over time (Synthetix StakingRewards)
/// @notice Rewards stream linearly over a period and accrue by stake × time (depth-over-time), so
///         real liquidity is rewarded, not a one-block flash. The reward distributor (a gauge
///         emission feed) funds it via `notifyRewardAmount`. The canonical, battle-tested accrual.
contract LiquidityGauge {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    address public immutable rewardDistributor;
    uint256 private constant ACC = 1e18;

    uint256 public rewardRate;          // reward tokens per second
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event RewardAdded(uint256 amount, uint256 duration);

    constructor(IERC20 stakeToken_, IERC20 rewardToken_, address rewardDistributor_) {
        require(address(stakeToken_) != address(0) && address(rewardToken_) != address(0), "zero");
        require(rewardDistributor_ != address(0), "distributor=0");
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        rewardDistributor = rewardDistributor_;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdate = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdate) * rewardRate * ACC) / totalSupply;
    }

    function earned(address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / ACC + rewards[account];
    }

    function stake(uint256 amount) external updateReward(msg.sender) {
        require(amount > 0, "amount=0");
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external updateReward(msg.sender) {
        require(amount > 0 && balanceOf[msg.sender] >= amount, "bad amount");
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() external updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Fund `reward` tokens to stream over `duration` seconds.
    function notifyRewardAmount(uint256 reward, uint256 duration) external updateReward(address(0)) {
        require(msg.sender == rewardDistributor, "not distributor");
        require(duration > 0 && reward > 0, "bad params");
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / duration;
        } else {
            uint256 remaining = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + remaining) / duration;
        }
        rewardToken.safeTransferFrom(msg.sender, address(this), reward);
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(reward, duration);
    }
}
