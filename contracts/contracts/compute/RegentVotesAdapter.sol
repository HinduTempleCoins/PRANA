// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {RegentGovernance} from "./RegentGovernance.sol";

/// @title RegentVotesAdapter (backlog QQ2) — an {IVotes} façade exposing the decaying regent weight.
/// @notice Lets a {GovernorDAO}/{VeGovernor} read the founding-regent's time-decaying governance
///         weight through the standard {IVotes} surface (`getVotes`/`getPastVotes`). The regent
///         account votes ONLY through this adapter; every other address reads 0.
///
/// @dev WHY NO CHECKPOINTS (the key difference from {VeVotesAdapter}):
///      {VeVotesAdapter} must checkpoint because {VoteEscrow} weight depends on per-user mutable
///      lock state with NO history. The regent weight, by contrast, is a CLOSED-FORM, DETERMINISTIC
///      function of time fixed at {RegentGovernance} construction — so the exact weight at ANY past
///      timepoint is recomputed on demand from the published schedule. No snapshots, no staleness,
///      no over-estimate window. The one mutable input is early `renounce()`, which forces weight to
///      0 from then on; this adapter reflects renouncement by reading `weight()`/`weightAt` live.
///
///      CLOCK — TIMESTAMP MODE (deliberate, and distinct from {VeVotesAdapter}'s block-number mode):
///      the regent decay schedule is denominated in unix SECONDS, so this adapter runs the Governor
///      in EIP-6372 timestamp mode. A Governor using this adapter as its `IVotes token` will take
///      its proposal snapshots in timestamps, matching the schedule exactly. (Do not mix this
///      adapter into a block-number Governor; pick one clock per Governor.)
///
///      TIME-BOUNDEDNESS (the required QQ2 property): because `getPastVotes` recomputes weight from
///      the schedule, any query at-or-after `regent.end()` PROVABLY returns 0 — there is no stored
///      value that could linger. A renounced regent returns 0 for every timepoint at/after the
///      renounce time as well (live `renounced` flag). Future-timepoint lookups revert, mirroring
///      OZ {Votes}/{VeVotesAdapter} semantics.
contract RegentVotesAdapter is IVotes, IERC6372 {
    /// @notice The regent weight source whose deterministic decay curve this adapter exposes.
    RegentGovernance public immutable regent;

    /// @notice The single account whose votes carry the regent weight (the founding-regent key at
    ///         deploy time). All other accounts read 0. Immutable: weight cannot be re-pointed.
    address public immutable regentAccount;

    error FutureLookup();
    error ZeroAddress();

    /// @param regent_ the {RegentGovernance} schedule contract.
    /// @param regentAccount_ the account that votes with the regent weight (typically `regent.admin`).
    constructor(RegentGovernance regent_, address regentAccount_) {
        if (address(regent_) == address(0) || regentAccount_ == address(0)) revert ZeroAddress();
        regent = regent_;
        regentAccount = regentAccount_;
    }

    // ------------------------------------------------------------------------------------------
    // EIP-6372 clock (TIMESTAMP mode — the regent schedule is in seconds)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IERC6372
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    /// @inheritdoc IERC6372
    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    // ------------------------------------------------------------------------------------------
    // IVotes reads — regentAccount carries the live/historical decayed weight; everyone else 0.
    // ------------------------------------------------------------------------------------------

    /// @notice Current decayed regent weight for `account` (0 unless `account` is the regent).
    function getVotes(address account) external view returns (uint256) {
        if (account != regentAccount) return 0;
        return regent.weight();
    }

    /// @notice Regent weight for `account` as of past timepoint `timepoint` (a unix timestamp).
    /// @dev Recomputed from the published schedule, so it PROVABLY returns 0 at/after `regent.end()`
    ///      (or at/after an early renounce). `timepoint` must be strictly in the past.
    ///      NOTE: if the regent renounced, the live `renounced` flag zeroes ALL timepoints (including
    ///      ones before renouncement) — acceptable because renouncement is a permanent stand-down and
    ///      open proposals should not retroactively bank regent weight.
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup();
        if (account != regentAccount) return 0;
        return regent.weightAt(timepoint);
    }

    /// @notice Total regent voting weight as of past timepoint `timepoint`.
    /// @dev Only the regent contributes, so total == the regent's weight at that timepoint.
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup();
        return regent.weightAt(timepoint);
    }

    // ------------------------------------------------------------------------------------------
    // IVotes delegation surface — intentionally inert (mirrors VeVotesAdapter).
    // ------------------------------------------------------------------------------------------
    // The regent weight is non-transferable and bound to `regentAccount`; there is no delegation.
    // These exist only to satisfy the IVotes interface the Governor requires.

    /// @inheritdoc IVotes
    function delegates(address account) external pure returns (address) {
        return account;
    }

    /// @inheritdoc IVotes
    function delegate(address) external pure {
        revert("regent: no delegation");
    }

    /// @inheritdoc IVotes
    function delegateBySig(address, uint256, uint256, uint8, bytes32, bytes32) external pure {
        revert("regent: no delegation");
    }
}
