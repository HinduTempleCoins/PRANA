// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RegentGovernance (backlog QQ1) — a founding-regent weight that decays linearly to zero.
/// @notice Progressive-decentralization primitive modelled on the BLURT `@regent` account: a
///         founding regent (VKFRI) holds a controlling GOVERNANCE weight at genesis that decays
///         LINEARLY to exactly 0 over a published, fixed schedule (e.g. 24 monthly steps ≈ 2yr).
///         After the schedule ends the regent weight is 0 forever and the chain is a full community
///         DAO. The regent steers (governance / task-direction) but NEVER extracts.
///
/// @dev THE LOAD-BEARING SAFETY PROPERTY — "steering, not extraction" (no-premine-compatible):
///      This contract is INCAPABLE BY CONSTRUCTION of touching circulating supply. It holds no
///      token, has no `IERC20`/mint/transfer import, no rewards-pool reference, no `payable` path,
///      and never moves value. Its entire surface is:
///        * a pure decay calculation (`weight`, `weightAt`), and
///        * read helpers a votes-adapter / Governor consults to weigh the regent's governance vote.
///      There is therefore no code path that can mint, move emission, or touch the rewards pool —
///      auditors verify this by inspecting the (deliberately tiny) import + state surface. The only
///      mutating actions are: (a) the admin RENOUNCING early (weight can only ever go DOWN), and
///      (b) transferring the admin key. Weight is monotonic NON-INCREASING in time and can never be
///      raised — there is no setter that increases `initialWeight`, extends the schedule, or resets
///      `start`.
///
///      DECAY SCHEDULE (continuous linear, distinct from VoteEscrow's per-user decay):
///        weight(t) = initialWeight * (end - t) / duration   for start ≤ t < end
///        weight(t) = initialWeight                          for t ≤ start   (full weight pre-start)
///        weight(t) = 0                                      for t ≥ end      (end = start+duration)
///      Unlike {VoteEscrow} (where each lock decays on its own user-chosen end), the regent decay is
///      a SINGLE FIXED SCHEDULE published at construction — every observer computes the same curve.
contract RegentGovernance {
    /// @notice The regent's weight at (and before) `start` — the genesis controlling weight.
    /// @dev Immutable: there is no path to raise it. Renouncement zeroes `_renounced` floor instead.
    uint256 public immutable initialWeight;

    /// @notice Unix timestamp at which the linear decay begins.
    uint256 public immutable start;

    /// @notice Decay duration in seconds; weight hits exactly 0 at `start + duration`.
    uint256 public immutable duration;

    /// @notice The regent admin (VKFRI). May renounce early or transfer the key; may NEVER increase
    ///         weight. Steering only.
    address public admin;

    /// @notice Once renounced, weight is forced to 0 for all time regardless of the schedule.
    bool public renounced;

    error ZeroInitialWeight();
    error ZeroDuration();
    error NotAdmin();
    error ZeroAddress();
    error AlreadyRenounced();

    /// @notice Emitted at construction with the full, published decay schedule.
    event RegentScheduled(address indexed admin, uint256 initialWeight, uint256 start, uint256 end);
    /// @notice Emitted when the regent renounces early; weight is 0 from here on.
    event RegentRenounced(address indexed admin, uint256 atTimestamp);
    /// @notice Emitted when the admin key is transferred (steering custody, not weight).
    event AdminTransferred(address indexed from, address indexed to);

    /// @param admin_         the founding-regent key (VKFRI).
    /// @param initialWeight_ the genesis controlling weight (must be > 0).
    /// @param start_         unix timestamp decay begins (0 ⇒ now).
    /// @param duration_      seconds over which weight decays to exactly 0 (must be > 0).
    constructor(address admin_, uint256 initialWeight_, uint256 start_, uint256 duration_) {
        if (admin_ == address(0)) revert ZeroAddress();
        if (initialWeight_ == 0) revert ZeroInitialWeight();
        if (duration_ == 0) revert ZeroDuration();
        admin = admin_;
        initialWeight = initialWeight_;
        start = start_ == 0 ? block.timestamp : start_;
        duration = duration_;
        emit RegentScheduled(admin_, initialWeight_, start, start + duration_);
    }

    // ------------------------------------------------------------------------------------------
    // Decay math — pure functions of time; the ONLY thing this contract computes.
    // ------------------------------------------------------------------------------------------

    /// @notice Unix timestamp at which the regent weight reaches exactly 0.
    function end() public view returns (uint256) {
        return start + duration;
    }

    /// @notice The regent weight at an arbitrary timestamp `t` (monotonic non-increasing in `t`).
    /// @dev Linear interpolation; returns full weight before `start`, exactly 0 at/after `end`, and
    ///      0 forever once renounced. No rounding can push it above `initialWeight` or below 0.
    function weightAt(uint256 t) public view returns (uint256) {
        if (renounced) return 0;
        if (t <= start) return initialWeight;
        uint256 e = start + duration;
        if (t >= e) return 0;
        // start < t < end ⇒ 0 < (e - t) < duration ⇒ result strictly between 0 and initialWeight.
        return (initialWeight * (e - t)) / duration;
    }

    /// @notice The regent weight right now (by `block.timestamp`).
    function weight() public view returns (uint256) {
        return weightAt(block.timestamp);
    }

    // ------------------------------------------------------------------------------------------
    // Steering custody — renounce / transfer. Weight can ONLY ever decrease.
    // ------------------------------------------------------------------------------------------

    /// @notice Regent renounces early: weight becomes 0 immediately and permanently. Irreversible.
    function renounce() external {
        if (msg.sender != admin) revert NotAdmin();
        if (renounced) revert AlreadyRenounced();
        renounced = true;
        emit RegentRenounced(admin, block.timestamp);
    }

    /// @notice Transfer the regent steering key. Does NOT change weight or the schedule.
    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert ZeroAddress();
        address from = admin;
        admin = to;
        emit AdminTransferred(from, to);
    }
}
