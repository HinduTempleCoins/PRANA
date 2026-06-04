// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VoteEscrow — lock a token for time-decaying voting weight (veCRV model, simplified)
/// @notice Lock `token` until an end time; weight = amount * timeRemaining / maxLock, decaying
///         linearly to 0 at unlock, after which the principal is withdrawable. Longer lock = more
///         weight. Used by the GaugeController and DAO Governor to weight stake-not-compute.
contract VoteEscrow {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public immutable maxLock; // seconds

    struct Lock { uint256 amount; uint64 end; }
    mapping(address => Lock) public locks;
    uint256 public totalLocked;

    event Locked(address indexed user, uint256 amount, uint64 end);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(IERC20 token_, uint256 maxLock_) {
        require(address(token_) != address(0) && maxLock_ > 0, "bad params");
        token = token_;
        maxLock = maxLock_;
    }

    function lock(uint256 amount, uint256 duration) external {
        require(amount > 0, "amount=0");
        require(duration > 0 && duration <= maxLock, "duration");
        Lock storage l = locks[msg.sender];
        require(l.amount == 0, "lock exists");
        token.safeTransferFrom(msg.sender, address(this), amount);
        l.amount = amount;
        l.end = uint64(block.timestamp + duration);
        totalLocked += amount;
        emit Locked(msg.sender, amount, l.end);
    }

    function increaseAmount(uint256 amount) external {
        Lock storage l = locks[msg.sender];
        require(l.amount > 0 && l.end > block.timestamp, "no active lock");
        require(amount > 0, "amount=0");
        token.safeTransferFrom(msg.sender, address(this), amount);
        l.amount += amount;
        totalLocked += amount;
        emit Locked(msg.sender, l.amount, l.end);
    }

    function extendLock(uint256 newDuration) external {
        Lock storage l = locks[msg.sender];
        require(l.amount > 0, "no lock");
        require(newDuration <= maxLock, "too long");
        uint64 newEnd = uint64(block.timestamp + newDuration);
        require(newEnd > l.end, "only extend");
        l.end = newEnd;
        emit Locked(msg.sender, l.amount, l.end);
    }

    /// @notice Current decaying voting weight of `user`.
    function balanceOf(address user) public view returns (uint256) {
        Lock memory l = locks[user];
        if (l.end <= block.timestamp) return 0;
        return (l.amount * (l.end - block.timestamp)) / maxLock;
    }

    function withdraw() external {
        Lock storage l = locks[msg.sender];
        require(l.amount > 0, "no lock");
        require(block.timestamp >= l.end, "still locked");
        uint256 amount = l.amount;
        l.amount = 0;
        l.end = 0;
        totalLocked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
}
