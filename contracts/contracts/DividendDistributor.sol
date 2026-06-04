// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DividendDistributor — stake an equity token, earn a share of distributed fees
/// @notice The "A dividend" mechanic, done with the proven Synthetix accumulator pattern (no
///         transfer-hook corrections). Stake `shareToken` (token A); anyone calls `distribute()`
///         to push `rewardToken` (fees from burns/DEX/lending); stakers claim pro-rata to their
///         staked time-weighted share. Activity funds the dividend — never the printer.
contract DividendDistributor {
    using SafeERC20 for IERC20;

    IERC20 public immutable shareToken;
    IERC20 public immutable rewardToken;
    uint256 private constant ACC = 1e18;

    uint256 public totalShares;
    uint256 public accRewardPerShare; // scaled by ACC
    mapping(address => uint256) public shares;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public pending;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Distributed(address indexed from, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    constructor(IERC20 shareToken_, IERC20 rewardToken_) {
        require(address(shareToken_) != address(0) && address(rewardToken_) != address(0), "zero");
        shareToken = shareToken_;
        rewardToken = rewardToken_;
    }

    function _settle(address u) internal {
        if (shares[u] > 0) {
            uint256 acc = (shares[u] * accRewardPerShare) / ACC;
            pending[u] += acc - rewardDebt[u];
        }
    }

    function _sync(address u) internal {
        rewardDebt[u] = (shares[u] * accRewardPerShare) / ACC;
    }

    function stake(uint256 amount) external {
        require(amount > 0, "amount=0");
        _settle(msg.sender);
        shareToken.safeTransferFrom(msg.sender, address(this), amount);
        shares[msg.sender] += amount;
        totalShares += amount;
        _sync(msg.sender);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external {
        require(shares[msg.sender] >= amount && amount > 0, "bad amount");
        _settle(msg.sender);
        shares[msg.sender] -= amount;
        totalShares -= amount;
        _sync(msg.sender);
        shareToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Push `amount` of reward token to be split across current stakers.
    function distribute(uint256 amount) external {
        require(totalShares > 0, "no shares");
        require(amount > 0, "amount=0");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        accRewardPerShare += (amount * ACC) / totalShares;
        emit Distributed(msg.sender, amount);
    }

    function claimable(address u) public view returns (uint256) {
        uint256 acc = (shares[u] * accRewardPerShare) / ACC;
        return pending[u] + acc - rewardDebt[u];
    }

    function claim() external returns (uint256 amount) {
        _settle(msg.sender);
        _sync(msg.sender);
        amount = pending[msg.sender];
        require(amount > 0, "nothing");
        pending[msg.sender] = 0;
        rewardToken.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
