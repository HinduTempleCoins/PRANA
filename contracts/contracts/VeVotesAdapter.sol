// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {VoteEscrow} from "./VoteEscrow.sol";

/// @title VeVotesAdapter — an {IVotes} façade that checkpoints time-decaying ve weight.
/// @notice OpenZeppelin's {Governor} weighs votes through the {IVotes} interface, which requires a
///         *historical* lookup: `getPastVotes(account, blockNumber)`. {VoteEscrow} cannot serve
///         that — its `balanceOf` is a live, continuously-decaying value with NO history. This
///         adapter bridges the two by recording block-stamped snapshots of each user's (and the
///         system's) ve weight, then binary-searching them for any past block.
///
/// @dev WHY EXPLICIT CHECKPOINTS (read this — it is the load-bearing design decision):
///      {VoteEscrow} exposes only `balanceOf(user)` and emits `Locked`/`Withdrawn`, but this
///      adapter is a SEPARATE contract and cannot hook into VoteEscrow's state transitions — there
///      is no callback, and Solidity can't observe another contract's events on-chain. So snapshots
///      are *self-served*: a user (or anyone, on their behalf) calls {checkpoint} to freeze the
///      caller-or-target's CURRENT decayed weight into the history at the current block. This is the
///      exact same opt-in, self-served snapshot pattern used by this codebase's BribeMarket (which
///      has the same "the source contract keeps no history" limitation against its GaugeController).
///
///      STALENESS / DECAY WINDOW (honest accounting — surfaced to integrators):
///      ve weight decays continuously between checkpoints, but a checkpoint freezes a single value.
///      Therefore the snapshot is generally an OVER-estimate of the true weight at any block strictly
///      after the checkpoint and at-or-before the next one (because real weight kept decaying while
///      the snapshot held flat). Two consequences:
///        1. A voter SHOULD `checkpoint` right before the proposal snapshot block (`clock()` at
///           propose time) to make their recorded weight match reality as closely as possible. The
///           UI must prompt this; an un-checkpointed user reads as 0 votes (see {getPastVotes}).
///        2. The over-estimate is bounded by how stale the checkpoint is. For governance this is
///           acceptable and symmetric (it applies equally to every voter and to total supply), but
///           it is NOT a substitute for VoteEscrow's live `balanceOf` when exact current weight is
///           needed. An EXPIRED lock checkpointed after expiry records 0; a lock checkpointed while
///           active and queried at a later block still returns the stale (higher) snapshot until
///           re-checkpointed — callers wanting freshness must re-checkpoint.
///
///      CLOCK: block-number mode (EIP-6372 default), matching the rest of the governance stack so a
///      {Governor} reading this adapter and a token-based one agree on timepoints.
contract VeVotesAdapter is IVotes, IERC6372 {
    using Checkpoints for Checkpoints.Trace224;

    /// @notice The vote-escrow contract whose live weights are snapshotted.
    VoteEscrow public immutable escrow;

    /// @dev Per-account block-stamped weight history (block number => snapshotted ve weight).
    mapping(address => Checkpoints.Trace224) private _userCheckpoints;
    /// @dev Block-stamped total-ve history (sum of all users' last-snapshotted weights).
    Checkpoints.Trace224 private _totalCheckpoints;

    /// @dev Each account's last snapshotted weight, so {checkpoint} can adjust the running total by
    ///      the delta (newWeight - oldSnapshot) instead of re-summing every account.
    mapping(address => uint256) private _lastSnapshot;

    error FutureLookup();
    error WeightOverflow();

    /// @notice Emitted when `account`'s ve weight is snapshotted at `blockNumber`.
    event Checkpointed(address indexed account, uint256 blockNumber, uint256 oldWeight, uint256 newWeight);

    constructor(VoteEscrow escrow_) {
        require(address(escrow_) != address(0), "escrow=0");
        escrow = escrow_;
    }

    // ------------------------------------------------------------------------------------------
    // EIP-6372 clock (block-number mode)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IERC6372
    function clock() public view override returns (uint48) {
        return uint48(block.number);
    }

    /// @inheritdoc IERC6372
    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=blocknumber&from=default";
    }

    // ------------------------------------------------------------------------------------------
    // Checkpointing (self-served snapshots — see contract NatSpec for the staleness rationale)
    // ------------------------------------------------------------------------------------------

    /// @notice Snapshot the caller's CURRENT ve weight into history at the current block.
    /// @dev Convenience wrapper for `checkpoint(msg.sender)`.
    function checkpoint() external returns (uint256 newWeight) {
        return _checkpoint(msg.sender);
    }

    /// @notice Snapshot `account`'s CURRENT ve weight into history at the current block.
    /// @dev Permissionless: anyone may checkpoint on another's behalf (it can only set the recorded
    ///      weight to the account's own true VoteEscrow weight, so there is no griefing vector — at
    ///      worst it refreshes someone's snapshot to a *lower*, more-accurate value).
    function checkpoint(address account) external returns (uint256 newWeight) {
        return _checkpoint(account);
    }

    function _checkpoint(address account) internal returns (uint256 newWeight) {
        newWeight = escrow.balanceOf(account);
        if (newWeight > type(uint224).max) revert WeightOverflow();

        uint256 oldWeight = _lastSnapshot[account];
        uint32 key = uint32(block.number);

        // Update the user's trace (push overwrites if a checkpoint already exists at this block).
        _userCheckpoints[account].push(key, uint224(newWeight));

        // Adjust the running total by the delta so the total trace stays consistent.
        uint256 newTotal = _totalCheckpoints.latest() + newWeight - oldWeight;
        if (newTotal > type(uint224).max) revert WeightOverflow();
        _totalCheckpoints.push(key, uint224(newTotal));

        _lastSnapshot[account] = newWeight;
        emit Checkpointed(account, key, oldWeight, newWeight);
    }

    // ------------------------------------------------------------------------------------------
    // IVotes reads
    // ------------------------------------------------------------------------------------------

    /// @notice Current snapshotted weight of `account` (the last value pushed, NOT live ve weight).
    /// @dev This is the last *checkpointed* value, which may be stale vs `escrow.balanceOf`. Call
    ///      {checkpoint} to refresh. Returns 0 if the account has never been checkpointed.
    function getVotes(address account) external view returns (uint256) {
        return _userCheckpoints[account].latest();
    }

    /// @notice Snapshotted weight of `account` as of the end of `timepoint` (a past block number).
    /// @dev Binary-searches the account's checkpoint trace for the most recent checkpoint at or
    ///      before `timepoint`. A user who never checkpointed (or last checkpointed an expired lock
    ///      to 0) reads as 0 at that timepoint. `timepoint` must be strictly in the past, mirroring
    ///      OZ {Votes} semantics.
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup();
        return _userCheckpoints[account].upperLookup(uint32(timepoint));
    }

    /// @notice Snapshotted total ve weight as of the end of `timepoint` (a past block number).
    /// @dev Sum of all accounts' last-snapshotted weights as it stood at `timepoint`. Because it is
    ///      assembled from per-user checkpoints, the total reflects only weight that has actually
    ///      been checkpointed by `timepoint` — un-checkpointed locks contribute to neither a user's
    ///      votes nor the quorum denominator, keeping the two consistent.
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup();
        return _totalCheckpoints.upperLookup(uint32(timepoint));
    }

    // ------------------------------------------------------------------------------------------
    // IVotes delegation surface — intentionally inert.
    // ------------------------------------------------------------------------------------------
    // ve weight is non-transferable and tied to the locker; there is no delegation. These exist
    // only to satisfy the IVotes interface the Governor's IERC5805 token type requires. `delegates`
    // reports self-delegation so any voting-power query attributes weight to the account itself.

    /// @inheritdoc IVotes
    function delegates(address account) external pure returns (address) {
        return account;
    }

    /// @inheritdoc IVotes
    function delegate(address) external pure {
        revert("ve: no delegation");
    }

    /// @inheritdoc IVotes
    function delegateBySig(address, uint256, uint256, uint8, bytes32, bytes32) external pure {
        revert("ve: no delegation");
    }
}
