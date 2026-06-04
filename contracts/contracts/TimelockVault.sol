// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TimelockVault
/// @notice Per-user time-locks: pull ERC-20 tokens in and release them only after
///         a chosen unlock timestamp, back to the original locker. Each user can
///         hold many independent locks, addressed by a globally unique lock id.
contract TimelockVault {
    using SafeERC20 for IERC20;

    struct Lock {
        address owner;      // who may withdraw
        address token;      // locked ERC-20
        uint256 amount;     // amount locked
        uint64 unlockTime;  // not withdrawable before this timestamp
        bool withdrawn;     // guards against double-withdraw
    }

    /// @dev lockId => Lock. Ids are sequential and never reused.
    mapping(uint256 => Lock) public locks;

    /// @dev Convenience index of lock ids per user.
    mapping(address => uint256[]) private _userLocks;

    uint256 public nextLockId;

    event Locked(
        uint256 indexed lockId,
        address indexed owner,
        address indexed token,
        uint256 amount,
        uint64 unlockTime
    );
    event Withdrawn(uint256 indexed lockId, address indexed owner, uint256 amount);

    /// @notice Lock `amount` of `token` until `unlockTime`. Tokens are pulled from msg.sender.
    /// @return lockId the id identifying this lock.
    function lock(IERC20 token, uint256 amount, uint64 unlockTime) external returns (uint256 lockId) {
        require(amount > 0, "amount=0");
        require(unlockTime > block.timestamp, "unlock in past");

        lockId = nextLockId++;
        locks[lockId] = Lock({
            owner: msg.sender,
            token: address(token),
            amount: amount,
            unlockTime: unlockTime,
            withdrawn: false
        });
        _userLocks[msg.sender].push(lockId);

        // Pull tokens in last; SafeERC20 reverts on failure. amount recorded is the
        // requested amount (caller must use a standard, non-fee-on-transfer token).
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(lockId, msg.sender, address(token), amount, unlockTime);
    }

    /// @notice Withdraw a matured lock back to its owner.
    function withdraw(uint256 lockId) external {
        Lock storage l = locks[lockId];
        require(l.owner != address(0), "no such lock");
        require(l.owner == msg.sender, "not lock owner");
        require(!l.withdrawn, "already withdrawn");
        require(block.timestamp >= l.unlockTime, "still locked");

        l.withdrawn = true;
        IERC20(l.token).safeTransfer(l.owner, l.amount);

        emit Withdrawn(lockId, l.owner, l.amount);
    }

    /// @notice All lock ids created by `user` (including withdrawn ones).
    function userLocks(address user) external view returns (uint256[] memory) {
        return _userLocks[user];
    }

    /// @notice Number of locks created by `user`.
    function userLockCount(address user) external view returns (uint256) {
        return _userLocks[user].length;
    }
}
