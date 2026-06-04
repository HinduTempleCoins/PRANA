// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {BurnStakeRegistry, IBurnStakeWeightHook} from "./BurnStakeRegistry.sol";

/// @title BurnStakeGovernanceAdapter — an {IVotes} façade over {BurnStakeRegistry} perma-stake weight.
/// @notice Exposes each account's PERMANENT burn-stake weight to OpenZeppelin's {Governor}
///         (GovernorDAO / VeGovernor), which weighs votes through {IVotes}'s historical
///         `getPastVotes(account, timepoint)` / `getPastTotalSupply(timepoint)`.
///
/// @dev WHY CHECKPOINTING IS STILL NEEDED (even though weight never decays):
///      The registry stores only LIVE cumulative weight (`weightOf` / `totalWeight`); it keeps no
///      block-stamped history. {Governor} requires a *past-block* lookup for replay-safe voting. So
///      this adapter records block-stamped snapshots and binary-searches them — the same machinery as
///      {VeVotesAdapter}, but the source signal is the OPPOSITE shape: monotonically NON-DECREASING
///      (a perma-stake accumulator) instead of continuously decaying. That asymmetry makes the
///      checkpoint semantics much cleaner here:
///        * For ve-decay, an un-refreshed snapshot is an *over*-estimate (the live value kept falling).
///        * For burn-stake, an un-refreshed snapshot is an *under*-estimate (the live value only rose),
///          which is the conservative, safe direction for governance: you can never vote with MORE
///          weight than you had burned as of the snapshot block.
///
///      CHECKPOINT APPROACH — AUTO via registry hook (primary), manual catch-up (fallback):
///      The {BurnStakeRegistry} calls {onWeightCredited} on THIS adapter at the exact block weight is
///      credited (the adapter is wired as the registry's `weightHook`). So the history is written
///      automatically the moment a burn happens — users do NOT have to remember to checkpoint, and a
///      freshly-burned voter is immediately counted at the correct block. The permissionless
///      {checkpoint} / {checkpoint(account)} remains as a catch-up path for any account whose weight
///      was credited before this adapter was wired as the hook (it re-reads the registry's live
///      weight and freezes it at the current block). Either way the recorded value is the account's
///      own true registry weight — there is no way to record MORE than was actually burned.
///
///      CAPTURE-RESISTANCE (the whole point): this weight CANNOT be flash-loaned or borrowed. The
///      registry has no transfer, no withdraw, and no unlock — weight is acquired ONLY by permanently
///      destroying value. A flash loan must be repaid in the same transaction; burned principal can
///      never be repaid, so no lender will front it. The rent-a-majority-stake (Steem/Justin-Sun)
///      governance takeover is structurally impossible against this lane.
///
///      CLOCK: block-number mode (EIP-6372 default), matching the rest of the governance stack so a
///      {Governor} reading this adapter and a token-based one agree on timepoints.
contract BurnStakeGovernanceAdapter is IVotes, IERC6372, IBurnStakeWeightHook {
    using Checkpoints for Checkpoints.Trace224;

    /// @notice The perma-stake registry whose cumulative weights are snapshotted.
    BurnStakeRegistry public immutable registry;

    /// @dev Per-account block-stamped weight history (block number => snapshotted cumulative weight).
    mapping(address => Checkpoints.Trace224) private _userCheckpoints;
    /// @dev Block-stamped total-weight history.
    Checkpoints.Trace224 private _totalCheckpoints;

    /// @dev Each account's last snapshotted weight, so a manual {checkpoint} can adjust the running
    ///      total by the delta (newWeight - oldSnapshot) without re-summing every account.
    mapping(address => uint256) private _lastSnapshot;

    error FutureLookup();
    error WeightOverflow();
    error NotRegistry();

    /// @notice Emitted when `account`'s burn-stake weight is snapshotted at `blockNumber`.
    event Checkpointed(address indexed account, uint256 blockNumber, uint256 oldWeight, uint256 newWeight);

    constructor(BurnStakeRegistry registry_) {
        require(address(registry_) != address(0), "registry=0");
        registry = registry_;
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
    // Auto-checkpoint hook (primary path) — called by the registry at the block weight is credited.
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IBurnStakeWeightHook
    /// @dev Only the wired registry may call. Receives the post-credit `newWeight`/`newTotalWeight`
    ///      directly, so no external read is needed and the snapshot is exact for this block.
    function onWeightCredited(address account, uint256 newWeight, uint256 newTotalWeight) external {
        if (msg.sender != address(registry)) revert NotRegistry();
        _writeCheckpoint(account, newWeight, newTotalWeight);
    }

    // ------------------------------------------------------------------------------------------
    // Manual catch-up checkpoint (fallback) — permissionless, re-reads live registry weight.
    // ------------------------------------------------------------------------------------------

    /// @notice Snapshot the caller's CURRENT registry weight into history at the current block.
    function checkpoint() external returns (uint256 newWeight) {
        return _checkpoint(msg.sender);
    }

    /// @notice Snapshot `account`'s CURRENT registry weight into history at the current block.
    /// @dev Permissionless: anyone may checkpoint on another's behalf — it can only set the recorded
    ///      weight to the account's own true registry weight, so there is no griefing vector (and
    ///      since weight is monotonic, it can only ever refresh UP to the current, never down).
    function checkpoint(address account) external returns (uint256 newWeight) {
        return _checkpoint(account);
    }

    function _checkpoint(address account) internal returns (uint256 newWeight) {
        newWeight = registry.weightOf(account);
        uint256 delta = newWeight - _lastSnapshot[account]; // monotonic ⇒ never underflows
        uint256 newTotal = _totalCheckpoints.latest() + delta;
        _writeCheckpoint(account, newWeight, newTotal);
    }

    /// @dev The single history writer. `newTotal` is the post-update running total to record.
    function _writeCheckpoint(address account, uint256 newWeight, uint256 newTotal) internal {
        if (newWeight > type(uint224).max || newTotal > type(uint224).max) revert WeightOverflow();

        uint256 oldWeight = _lastSnapshot[account];
        uint32 key = uint32(block.number);

        // push overwrites if a checkpoint already exists at this block (e.g. two burns same block).
        _userCheckpoints[account].push(key, uint224(newWeight));
        _totalCheckpoints.push(key, uint224(newTotal));

        _lastSnapshot[account] = newWeight;
        emit Checkpointed(account, key, oldWeight, newWeight);
    }

    // ------------------------------------------------------------------------------------------
    // IVotes reads
    // ------------------------------------------------------------------------------------------

    /// @notice Current snapshotted weight of `account` (the last value pushed).
    /// @dev With the auto-checkpoint hook wired this tracks the live registry weight; if the adapter
    ///      was wired late, call {checkpoint} to catch up. Returns 0 if never checkpointed.
    function getVotes(address account) external view returns (uint256) {
        return _userCheckpoints[account].latest();
    }

    /// @notice Snapshotted weight of `account` as of the end of `timepoint` (a past block number).
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup();
        return _userCheckpoints[account].upperLookup(uint32(timepoint));
    }

    /// @notice Snapshotted total burn-stake weight as of the end of `timepoint` (a past block number).
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert FutureLookup();
        return _totalCheckpoints.upperLookup(uint32(timepoint));
    }

    // ------------------------------------------------------------------------------------------
    // IVotes delegation surface — intentionally inert.
    // ------------------------------------------------------------------------------------------
    // Burn-stake weight is non-transferable and tied to the burner; there is no delegation. These
    // exist only to satisfy the IVotes interface. `delegates` self-delegates so every voting-power
    // query attributes weight to the account itself.

    /// @inheritdoc IVotes
    function delegates(address account) external pure returns (address) {
        return account;
    }

    /// @inheritdoc IVotes
    function delegate(address) external pure {
        revert("burn-stake: no delegation");
    }

    /// @inheritdoc IVotes
    function delegateBySig(address, uint256, uint256, uint8, bytes32, bytes32) external pure {
        revert("burn-stake: no delegation");
    }
}
