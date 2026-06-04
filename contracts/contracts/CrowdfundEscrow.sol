// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Kickstarter-style all-or-nothing crowdfund denominated in an ERC-20 token.
/// @dev Contributors pledge before the deadline. After the deadline: if the total
///      raised meets the goal the beneficiary claims everything; otherwise each
///      contributor reclaims exactly what they pledged. Pull-based, no double-spend.
contract CrowdfundEscrow {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    uint256 public immutable goal;
    uint64 public immutable deadline;

    uint256 public totalRaised;
    bool public claimed;

    mapping(address => uint256) public contributions;

    event Contributed(address indexed contributor, uint256 amount, uint256 totalRaised);
    event Claimed(address indexed beneficiary, uint256 amount);
    event Refunded(address indexed contributor, uint256 amount);

    error ZeroAddress();
    error ZeroGoal();
    error DeadlineInPast();
    error ZeroAmount();
    error FundingClosed();
    error FundingOngoing();
    error GoalNotMet();
    error GoalMet();
    error AlreadyClaimed();
    error NothingToRefund();

    constructor(IERC20 token_, address beneficiary_, uint256 goal_, uint64 deadline_) {
        if (address(token_) == address(0) || beneficiary_ == address(0)) revert ZeroAddress();
        if (goal_ == 0) revert ZeroGoal();
        if (deadline_ <= block.timestamp) revert DeadlineInPast();
        token = token_;
        beneficiary = beneficiary_;
        goal = goal_;
        deadline = deadline_;
    }

    /// @notice Pledge `amount` of the campaign token before the deadline.
    /// @dev Pulls funds via transferFrom; caller must have approved this contract.
    function contribute(uint256 amount) external {
        if (block.timestamp >= deadline) revert FundingClosed();
        if (amount == 0) revert ZeroAmount();

        contributions[msg.sender] += amount;
        totalRaised += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Contributed(msg.sender, amount, totalRaised);
    }

    /// @notice After a successful campaign, the beneficiary withdraws all funds.
    function claim() external {
        if (block.timestamp < deadline) revert FundingOngoing();
        if (totalRaised < goal) revert GoalNotMet();
        if (claimed) revert AlreadyClaimed();

        claimed = true;
        uint256 amount = totalRaised;
        token.safeTransfer(beneficiary, amount);
        emit Claimed(beneficiary, amount);
    }

    /// @notice After a failed campaign, each contributor reclaims their pledge.
    function refund() external {
        if (block.timestamp < deadline) revert FundingOngoing();
        if (totalRaised >= goal) revert GoalMet();

        uint256 amount = contributions[msg.sender];
        if (amount == 0) revert NothingToRefund();

        contributions[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Refunded(msg.sender, amount);
    }

    /// @return true once the deadline has passed with the goal met.
    function succeeded() external view returns (bool) {
        return block.timestamp >= deadline && totalRaised >= goal;
    }
}
