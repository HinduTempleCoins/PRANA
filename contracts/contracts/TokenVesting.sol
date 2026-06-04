// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TokenVesting — linear vesting with an optional cliff
/// @notice Releases `total` tokens to `beneficiary` linearly from `start` over `duration`, with
///         nothing claimable before the cliff. Withdraw-anytime up to the vested amount (no big
///         cliff unlocks beyond the configured cliff). Fund the contract with `total` after deploy.
///         Immutable and transparent (publish the address) — fits the no-premine posture.
contract TokenVesting {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    uint64 public immutable start;
    uint64 public immutable cliff;     // absolute timestamp; nothing vests before this
    uint64 public immutable duration;  // seconds from start to fully vested
    uint256 public immutable total;
    uint256 public released;

    event Released(uint256 amount);

    constructor(
        IERC20 token_,
        address beneficiary_,
        uint64 start_,
        uint64 cliffSeconds_,
        uint64 duration_,
        uint256 total_
    ) {
        require(address(token_) != address(0), "token=0");
        require(beneficiary_ != address(0), "beneficiary=0");
        require(duration_ > 0, "duration=0");
        require(cliffSeconds_ <= duration_, "cliff>duration");
        require(total_ > 0, "total=0");
        token = token_;
        beneficiary = beneficiary_;
        start = start_;
        cliff = start_ + cliffSeconds_;
        duration = duration_;
        total = total_;
    }

    /// @notice Tokens vested by timestamp `ts`.
    function vestedAmount(uint64 ts) public view returns (uint256) {
        if (ts < cliff) return 0;
        if (ts >= start + duration) return total;
        return (total * (ts - start)) / duration;
    }

    /// @notice Tokens currently claimable.
    function releasable() public view returns (uint256) {
        return vestedAmount(uint64(block.timestamp)) - released;
    }

    /// @notice Release all currently-vested tokens to the beneficiary.
    function release() external returns (uint256 amount) {
        amount = releasable();
        require(amount > 0, "nothing to release");
        released += amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(amount);
    }
}
