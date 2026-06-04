// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IReputationRegistry — per-contributor reputation + tier read surface.
/// @notice A non-transferable score that rises on verified good work and falls on slashes. Tier
///         thresholds (governed) bucket the raw score into discrete access tiers. Task-types name a
///         {minReputation} tier; {HumanTaskCreditor} reads {tierOf} to gate access to that work.
interface IReputationRegistry {
    /// @notice The raw non-transferable reputation score of `who`.
    function reputationOf(address who) external view returns (uint256);

    /// @notice The discrete tier `who` currently sits in (0 = untrusted; higher = more trusted).
    function tierOf(address who) external view returns (uint256);

    /// @notice The optional slashable PRANA stake `who` has posted as a good-faith bond.
    function stakeOf(address who) external view returns (uint256);
}
