// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGaugeController} from "./interfaces/IGaugeController.sol";

/// @title BribeMarket — vote-incentive escrow on top of a {GaugeController}
/// @notice "Bribes" (vote incentives) let anyone deposit a reward token earmarked for a (gauge,
///         epoch). Voters who directed their ve weight to that gauge in that epoch claim the bribe
///         pro-rata to their recorded vote weight. Unclaimed bribes are sweepable by the briber
///         after an expiry window so funds are never trapped.
/// @dev WHY AN INTERNAL SNAPSHOT (important design note):
///      The {GaugeController} this sits on stores only *live* state — `userWeight(user)`,
///      `userGauge(user)`, `gaugeWeight(gauge)` — and exposes NO per-epoch history. Curve's real
///      bribe markets read a historical gauge-weight snapshot from the controller; ours can't,
///      because re-voting overwrites a user's weight in place and the controller keeps no epoch log.
///
///      So BribeMarket keeps its OWN epoch snapshot, populated by the voters themselves:
///        1. Off-chain (or a keeper) advances epochs by calling `advanceEpoch()` (monotonic, time-
///           gated by `epochLength`), or any deposit auto-rolls the epoch when the window passes.
///        2. After voting in the GaugeController for the current epoch, a voter calls
///           `checkpoint(gauge)`. We read their *current* `userGauge`/`userWeight` from the
///           controller and record (epoch, gauge, user) -> weight, accumulating the gauge's total
///           snapshotted weight for that epoch. A voter may only checkpoint a gauge they are
///           currently voting for, and only once per (epoch, gauge).
///        3. Claims divide a bribe by the gauge's snapshotted total for that epoch and pay each
///           checkpointed voter their share.
///      This makes the snapshot opt-in and self-served (no privileged snapshotter), at the cost of
///      requiring voters to checkpoint to be eligible — documented and surfaced to the user below.
contract BribeMarket {
    using SafeERC20 for IERC20;

    IGaugeController public immutable controller;
    /// @notice Minimum seconds between epochs; an epoch can be advanced once this has elapsed.
    uint256 public immutable epochLength;
    /// @notice After this many seconds past an epoch's end, a briber may sweep unclaimed funds.
    uint256 public immutable expiryWindow;

    uint256 public currentEpoch;
    /// @notice Unix time at which the current epoch started.
    uint256 public epochStart;

    struct Bribe {
        address briber;
        address gauge;
        uint256 epoch;
        IERC20 token;
        uint256 amount;       // total deposited
        uint256 claimed;      // total claimed so far
        bool swept;
    }

    /// @notice All bribes by id.
    Bribe[] public bribes;

    /// @notice epoch => gauge => total snapshotted vote weight (sum over checkpointed voters).
    mapping(uint256 => mapping(address => uint256)) public epochGaugeWeight;
    /// @notice epoch => gauge => user => snapshotted vote weight.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public voterWeight;
    /// @notice bribeId => user => already claimed flag.
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    error ZeroAddress();
    error BadEpoch();
    error EpochNotElapsed();
    error NotVotingForGauge();
    error AlreadyCheckpointed();
    error NoWeight();
    error ZeroAmount();
    error BribeNotFound();
    error WrongEpoch();
    error NothingToClaim();
    error AlreadyClaimed();
    error NotExpired();
    error NotBriber();
    error AlreadySwept();

    event EpochAdvanced(uint256 indexed epoch, uint256 epochStart);
    event Checkpointed(uint256 indexed epoch, address indexed gauge, address indexed user, uint256 weight);
    event BribeDeposited(uint256 indexed bribeId, address indexed briber, address indexed gauge, uint256 epoch, address token, uint256 amount);
    event BribeClaimed(uint256 indexed bribeId, address indexed user, uint256 amount);
    event BribeSwept(uint256 indexed bribeId, address indexed briber, uint256 amount);

    constructor(IGaugeController controller_, uint256 epochLength_, uint256 expiryWindow_) {
        if (address(controller_) == address(0)) revert ZeroAddress();
        require(epochLength_ > 0 && expiryWindow_ > 0, "bad window");
        controller = controller_;
        epochLength = epochLength_;
        expiryWindow = expiryWindow_;
        epochStart = block.timestamp;
        emit EpochAdvanced(0, block.timestamp);
    }

    // ----------------------------------------------------------------------------------
    // Epoch management
    // ----------------------------------------------------------------------------------

    /// @notice End of the current epoch (when the next one may begin).
    function currentEpochEnd() public view returns (uint256) {
        return epochStart + epochLength;
    }

    /// @notice Advance to the next epoch once `epochLength` has elapsed. Permissionless and
    ///         monotonic; checkpoints/deposits are always against `currentEpoch`.
    function advanceEpoch() public {
        if (block.timestamp < currentEpochEnd()) revert EpochNotElapsed();
        currentEpoch += 1;
        epochStart = block.timestamp;
        emit EpochAdvanced(currentEpoch, epochStart);
    }

    /// @dev Auto-roll the epoch if the window has passed, so deposits/checkpoints land in a fresh
    ///      epoch without requiring a separate keeper call.
    function _maybeAdvance() internal {
        if (block.timestamp >= currentEpochEnd()) {
            advanceEpoch();
        }
    }

    // ----------------------------------------------------------------------------------
    // Snapshot (voter self-serve)
    // ----------------------------------------------------------------------------------

    /// @notice Record the caller's current vote weight on `gauge` for the current epoch. Must be
    ///         called AFTER voting in the GaugeController. Idempotency: at most once per
    ///         (epoch, gauge) per user.
    /// @dev Reads live controller state: the caller must currently have `userGauge == gauge` and a
    ///      non-zero `userWeight`. The snapshot freezes that weight for this epoch's claims, so
    ///      later re-votes don't retroactively change already-checkpointed bribe shares.
    function checkpoint(address gauge) external {
        _maybeAdvance();
        if (gauge == address(0)) revert ZeroAddress();
        uint256 epoch = currentEpoch;
        if (voterWeight[epoch][gauge][msg.sender] != 0) revert AlreadyCheckpointed();
        if (controller.userGauge(msg.sender) != gauge) revert NotVotingForGauge();
        uint256 w = controller.userWeight(msg.sender);
        if (w == 0) revert NoWeight();

        voterWeight[epoch][gauge][msg.sender] = w;
        epochGaugeWeight[epoch][gauge] += w;
        emit Checkpointed(epoch, gauge, msg.sender, w);
    }

    // ----------------------------------------------------------------------------------
    // Bribe lifecycle
    // ----------------------------------------------------------------------------------

    /// @notice Deposit a bribe of `amount` `token` for `gauge`, targeting `epoch`. `epoch` must be
    ///         the current epoch or a future one (you cannot bribe a past, already-settled epoch).
    /// @dev Fee-on-transfer safe: credits the actually-received amount (balance delta).
    function depositBribe(address gauge, uint256 epoch, IERC20 token, uint256 amount)
        external
        returns (uint256 bribeId)
    {
        _maybeAdvance();
        if (gauge == address(0) || address(token) == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (epoch < currentEpoch) revert BadEpoch();

        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        bribeId = bribes.length;
        bribes.push(Bribe({
            briber: msg.sender,
            gauge: gauge,
            epoch: epoch,
            token: token,
            amount: received,
            claimed: 0,
            swept: false
        }));
        emit BribeDeposited(bribeId, msg.sender, gauge, epoch, address(token), received);
    }

    /// @notice The amount `user` can claim from bribe `bribeId` (0 if not eligible / already claimed).
    function claimable(uint256 bribeId, address user) public view returns (uint256) {
        if (bribeId >= bribes.length) return 0;
        Bribe storage b = bribes[bribeId];
        if (hasClaimed[bribeId][user]) return 0;
        uint256 total = epochGaugeWeight[b.epoch][b.gauge];
        if (total == 0) return 0;
        uint256 w = voterWeight[b.epoch][b.gauge][user];
        if (w == 0) return 0;
        return (b.amount * w) / total;
    }

    /// @notice Claim the caller's pro-rata share of bribe `bribeId`.
    /// @dev Eligibility = the caller checkpointed `(epoch, gauge)`. Reverts on double-claim and on
    ///      a bribe whose gauge/epoch the caller never voted for (zero weight → NothingToClaim).
    function claim(uint256 bribeId) external returns (uint256 amount) {
        if (bribeId >= bribes.length) revert BribeNotFound();
        if (hasClaimed[bribeId][msg.sender]) revert AlreadyClaimed();
        Bribe storage b = bribes[bribeId];

        uint256 total = epochGaugeWeight[b.epoch][b.gauge];
        uint256 w = voterWeight[b.epoch][b.gauge][msg.sender];
        if (total == 0 || w == 0) revert NothingToClaim();

        amount = (b.amount * w) / total;
        if (amount == 0) revert NothingToClaim();

        hasClaimed[bribeId][msg.sender] = true;
        b.claimed += amount;
        b.token.safeTransfer(msg.sender, amount);
        emit BribeClaimed(bribeId, msg.sender, amount);
    }

    /// @notice True once bribe `bribeId` is eligible to be swept by its briber.
    /// @dev Two conditions, both required: (1) the bribe's target epoch is strictly in the past
    ///      (`currentEpoch > b.epoch`), so voters had a full epoch to checkpoint and claim; and
    ///      (2) `expiryWindow` seconds have elapsed since the *current* epoch began. Because epochs
    ///      advance lazily, anchoring (2) to `epochStart` is a conservative grace period that only
    ///      ever delays a sweep — it never lets a briber pull funds before voters could claim.
    function isSweepable(uint256 bribeId) public view returns (bool) {
        if (bribeId >= bribes.length) return false;
        Bribe storage b = bribes[bribeId];
        if (b.swept) return false;
        return currentEpoch > b.epoch && block.timestamp >= epochStart + expiryWindow;
    }

    /// @notice Briber reclaims the unclaimed remainder of bribe `bribeId` after expiry.
    /// @dev Allowed only once the bribe's target epoch is strictly in the past (so voters have had a
    ///      full epoch to checkpoint/claim) and the expiry window has elapsed in the current epoch.
    function sweep(uint256 bribeId) external returns (uint256 amount) {
        if (bribeId >= bribes.length) revert BribeNotFound();
        Bribe storage b = bribes[bribeId];
        if (msg.sender != b.briber) revert NotBriber();
        if (b.swept) revert AlreadySwept();
        // Target epoch must be settled (strictly past) and the expiry window elapsed.
        if (currentEpoch <= b.epoch) revert NotExpired();
        if (block.timestamp < epochStart + expiryWindow) revert NotExpired();

        amount = b.amount - b.claimed;
        if (amount == 0) revert NothingToClaim();
        b.swept = true;
        b.token.safeTransfer(b.briber, amount);
        emit BribeSwept(bribeId, b.briber, amount);
    }

    function bribeCount() external view returns (uint256) {
        return bribes.length;
    }
}
