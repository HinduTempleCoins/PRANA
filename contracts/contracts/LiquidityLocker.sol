// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LiquidityLocker
/// @notice Time-locks LP / ERC-20 tokens until an unlock time (anti-rug). Anyone can
///         create a lock on behalf of an owner; only that owner can withdraw, and only
///         after the unlock time. Lock duration can be extended but never shortened.
contract LiquidityLocker {
    using SafeERC20 for IERC20;

    struct Lock {
        IERC20 token;
        address owner;
        uint256 amount;
        uint64 unlockTime;
        bool withdrawn;
    }

    Lock[] private _locks;

    event Locked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockTime);
    event Extended(uint256 indexed id, uint64 newUnlockTime);
    event Unlocked(uint256 indexed id, address indexed owner, uint256 amount);

    /// @notice Pull `amount` of `token` from the caller and lock it for `owner` until `unlockTime`.
    /// @return id The identifier of the newly created lock.
    function lock(IERC20 token, uint256 amount, uint64 unlockTime, address owner) external returns (uint256 id) {
        require(address(token) != address(0), "token=0");
        require(owner != address(0), "owner=0");
        require(amount > 0, "amount=0");
        require(unlockTime > block.timestamp, "unlock in past");

        id = _locks.length;
        _locks.push(Lock({token: token, owner: owner, amount: amount, unlockTime: unlockTime, withdrawn: false}));

        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(id, address(token), owner, amount, unlockTime);
    }

    /// @notice Extend a lock's unlock time. Can only push the unlock time later, never earlier.
    function extend(uint256 id, uint64 newUnlock) external {
        Lock storage l = _locks[id];
        require(msg.sender == l.owner, "not owner");
        require(!l.withdrawn, "withdrawn");
        require(newUnlock > l.unlockTime, "must lengthen");
        l.unlockTime = newUnlock;
        emit Extended(id, newUnlock);
    }

    /// @notice Withdraw a matured lock to its owner. Owner-only, after unlockTime, once.
    function unlock(uint256 id) external {
        Lock storage l = _locks[id];
        require(msg.sender == l.owner, "not owner");
        require(!l.withdrawn, "withdrawn");
        require(block.timestamp >= l.unlockTime, "still locked");

        l.withdrawn = true;
        uint256 amount = l.amount;
        l.token.safeTransfer(l.owner, amount);

        emit Unlocked(id, l.owner, amount);
    }

    function locksCount() external view returns (uint256) {
        return _locks.length;
    }

    function getLock(uint256 id)
        external
        view
        returns (address token, address owner, uint256 amount, uint64 unlockTime, bool withdrawn)
    {
        Lock storage l = _locks[id];
        return (address(l.token), l.owner, l.amount, l.unlockTime, l.withdrawn);
    }
}
