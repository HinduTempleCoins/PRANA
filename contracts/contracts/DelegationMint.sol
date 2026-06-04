// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal interface for a role-gated mintable reward token (PoLToken-style).
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title DelegationMint — delegation mining with block-paced pro-rata emission
/// @notice Users *delegate* (lock) a stake token into this contract. There is no custody transfer
///         beyond the lock: the staked tokens sit here and can be undelegated at any time, at which
///         point the delegator's weight drops immediately. Every block, a fixed `emissionPerBlock`
///         of a reward token is minted and distributed pro-rata to the time-weighted delegated
///         stake (MasterChef-style `accRewardPerShare` accumulator). Rewards are pull-based via
///         `claim()`. This contract must hold the minter role on `rewardToken`.
contract DelegationMint {
    using SafeERC20 for IERC20;

    uint256 private constant ACC = 1e12;

    IERC20 public immutable stakeToken;
    IMintable public immutable rewardToken;
    uint256 public immutable emissionPerBlock;

    uint256 public totalDelegated;
    uint256 public accRewardPerShare; // scaled by ACC
    uint256 public lastRewardBlock;

    struct DelegationInfo {
        uint256 amount;     // currently delegated stake
        uint256 rewardDebt; // amount * accRewardPerShare / ACC at last touch
        uint256 pending;    // crystallized, unclaimed rewards
    }
    mapping(address => DelegationInfo) public delegations;

    event Delegated(address indexed user, uint256 amount, uint256 newAmount);
    event Undelegated(address indexed user, uint256 amount, uint256 newAmount);
    event Claimed(address indexed user, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientDelegation();

    constructor(IERC20 stakeToken_, IMintable rewardToken_, uint256 emissionPerBlock_) {
        if (address(stakeToken_) == address(0) || address(rewardToken_) == address(0)) revert ZeroAddress();
        if (emissionPerBlock_ == 0) revert ZeroAmount();
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        emissionPerBlock = emissionPerBlock_;
        lastRewardBlock = block.number;
    }

    /// @notice View of `accRewardPerShare` brought current to this block (without mutating state).
    function pendingAccPerShare() public view returns (uint256) {
        if (block.number <= lastRewardBlock || totalDelegated == 0) return accRewardPerShare;
        uint256 blocks = block.number - lastRewardBlock;
        uint256 reward = blocks * emissionPerBlock;
        return accRewardPerShare + (reward * ACC) / totalDelegated;
    }

    /// @notice Claimable reward for `user` as of the current block.
    function pendingReward(address user) external view returns (uint256) {
        DelegationInfo memory d = delegations[user];
        uint256 acc = pendingAccPerShare();
        return d.pending + (d.amount * acc) / ACC - d.rewardDebt;
    }

    /// @notice Current (immediately-droppable) delegated weight of `user`.
    function delegatedOf(address user) external view returns (uint256) {
        return delegations[user].amount;
    }

    /// @dev Advance the accumulator to the current block. No emission while nothing is delegated
    ///      (those blocks' emission is simply skipped, not back-paid).
    function _updatePool() internal {
        if (block.number <= lastRewardBlock) return;
        if (totalDelegated == 0) {
            lastRewardBlock = block.number;
            return;
        }
        uint256 blocks = block.number - lastRewardBlock;
        uint256 reward = blocks * emissionPerBlock;
        accRewardPerShare += (reward * ACC) / totalDelegated;
        lastRewardBlock = block.number;
    }

    /// @dev Crystallize the caller's accrued reward into `pending` before changing their weight.
    function _harvest(DelegationInfo storage d) internal {
        if (d.amount > 0) {
            d.pending += (d.amount * accRewardPerShare) / ACC - d.rewardDebt;
        }
    }

    /// @notice Delegate (lock) `amount` of stakeToken, increasing your time-weighted weight.
    function delegate(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _updatePool();
        DelegationInfo storage d = delegations[msg.sender];
        _harvest(d);

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        d.amount += amount;
        totalDelegated += amount;
        d.rewardDebt = (d.amount * accRewardPerShare) / ACC;

        emit Delegated(msg.sender, amount, d.amount);
    }

    /// @notice Undelegate (unlock) `amount`; weight drops immediately, stake returns to you.
    function undelegate(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        DelegationInfo storage d = delegations[msg.sender];
        if (amount > d.amount) revert InsufficientDelegation();
        _updatePool();
        _harvest(d);

        d.amount -= amount;
        totalDelegated -= amount;
        d.rewardDebt = (d.amount * accRewardPerShare) / ACC;
        stakeToken.safeTransfer(msg.sender, amount);

        emit Undelegated(msg.sender, amount, d.amount);
    }

    /// @notice Mint and pull all accrued rewards to the caller. Returns 0 when nothing accrued.
    function claim() external returns (uint256 reward) {
        _updatePool();
        DelegationInfo storage d = delegations[msg.sender];
        _harvest(d);
        d.rewardDebt = (d.amount * accRewardPerShare) / ACC;

        reward = d.pending;
        if (reward > 0) {
            d.pending = 0;
            rewardToken.mint(msg.sender, reward);
            emit Claimed(msg.sender, reward);
        }
    }
}
