// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IRegentGovernance — read surface for the decaying founder-regent governance weight.
/// @notice The founding regent (VKFRI) holds a controlling GOVERNANCE weight at genesis that
///         decays linearly to 0 over a fixed schedule (BLURT founder-decay model). After the
///         schedule ends the regent weight is 0 forever and the chain is fully community-governed.
///         Consumers — chiefly {RegentVotesAdapter} (which republishes this as `IVotes` weight) and
///         any front-end dashboard showing "founder influence remaining" — read the CURRENT weight
///         and the schedule end, never write. This interface is incapable of touching supply.
/// @dev STRUCTURAL binding (intentional): {RegentGovernance} does NOT declare `is IRegentGovernance`.
///      That contract carries a load-bearing audit claim of a "deliberately tiny import surface — no
///      IERC20/mint/transfer import" so auditors can verify by inspection that it cannot move value;
///      adding any import (even an interface) would dilute that signal. The signatures below match
///      `end()`/`weightAt(uint256)`/`weight()` EXACTLY, so callers (e.g. {RegentVotesAdapter}, the
///      front-end) bind this interface to the deployed address and read it the same way — no
///      inheritance is required for an external caller to use a matching interface.
interface IRegentGovernance {
    /// @notice Timestamp at which the regent weight reaches (and stays) 0.
    function end() external view returns (uint256);

    /// @notice The linearly-decayed regent governance weight at an arbitrary timestamp `t`
    ///         (0 once `t >= end()`). Pure schedule read — same value the votes adapter snapshots.
    function weightAt(uint256 t) external view returns (uint256);

    /// @notice The regent's current governance weight (decayed to `block.timestamp`).
    function weight() external view returns (uint256);
}
