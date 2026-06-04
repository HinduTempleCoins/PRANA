// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IVoteEscrow — lock a token for time-decaying voting weight (veCRV model, simplified)
/// @notice External surface of the vote-escrow: lock a token until an end time for decaying weight.
interface IVoteEscrow {
    event Locked(address indexed user, uint256 amount, uint64 end);
    event Withdrawn(address indexed user, uint256 amount);

    function token() external view returns (address);
    function maxLock() external view returns (uint256);
    function locks(address user) external view returns (uint256 amount, uint64 end);
    function totalLocked() external view returns (uint256);

    function lock(uint256 amount, uint256 duration) external;
    function increaseAmount(uint256 amount) external;
    function extendLock(uint256 newDuration) external;

    /// @notice Current decaying voting weight of `user`.
    function balanceOf(address user) external view returns (uint256);

    function withdraw() external;
}
