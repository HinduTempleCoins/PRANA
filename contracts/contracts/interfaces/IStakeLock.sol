// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IStakeLock — lock a token for a tier duration to mint time-decaying credits.
/// @notice External surface of {StakeLock}: a tier admin configures duration => multiplier(bps)
///         tiers; a user locks an amount for a configured duration, receiving `baseCredits` that
///         decay linearly to zero at unlock; the user withdraws the principal after unlock.
interface IStakeLock {
    struct Position {
        uint256 amount;
        uint256 baseCredits;
        uint64 start;
        uint64 end;
    }

    event TierSet(uint256 indexed duration, uint256 multiplierBps);
    event Locked(address indexed user, uint256 amount, uint256 duration, uint256 baseCredits, uint64 end);
    event Withdrawn(address indexed user, uint256 amount);

    function lockToken() external view returns (address);
    function multiplierBps(uint256 duration) external view returns (uint256);
    function positions(address user)
        external
        view
        returns (uint256 amount, uint256 baseCredits, uint64 start, uint64 end);

    // --- admin ------------------------------------------------------------ //
    function setTier(uint256 duration, uint256 bps) external;

    // --- user ------------------------------------------------------------- //
    function lock(uint256 amount, uint256 duration) external;
    function withdraw() external;

    // --- views ------------------------------------------------------------ //
    function creditsOf(address account) external view returns (uint256);
}
