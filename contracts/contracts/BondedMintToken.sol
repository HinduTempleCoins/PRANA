// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {StakeLock} from "./StakeLock.sol";
import {VoteEscrow} from "./VoteEscrow.sol";

/// @dev Pluggable weight oracle. Returns a (live) weight for an account that the bonded mint
///      distributes emission against. Implementations read whatever upstream weight makes sense
///      (locked credits, ve-balance, ...).
interface IWeightSource {
    function weightOf(address account) external view returns (uint256);
}

/// @notice Adapter reading {StakeLock.creditsOf} (decaying resource credits) as the mint weight.
contract StakeLockWeightSource is IWeightSource {
    StakeLock public immutable stakeLock;

    constructor(StakeLock stakeLock_) {
        stakeLock = stakeLock_;
    }

    function weightOf(address account) external view returns (uint256) {
        return stakeLock.creditsOf(account);
    }
}

/// @notice Adapter reading {VoteEscrow.balanceOf} (decaying ve-weight) as the mint weight.
contract VoteEscrowWeightSource is IWeightSource {
    VoteEscrow public immutable voteEscrow;

    constructor(VoteEscrow voteEscrow_) {
        voteEscrow = voteEscrow_;
    }

    function weightOf(address account) external view returns (uint256) {
        return voteEscrow.balanceOf(account);
    }
}

/// @title BondedMintToken — epoch snapshot-weighted bonded mint (the NutBox model)
/// @notice THIS CONTRACT IS THE BONDED ERC-20. Each epoch a fixed (decaying) `epochEmission` of new
///         tokens is distributed pro-rata to participants' weight read from a pluggable
///         {IWeightSource} (e.g. StakeLock credits or VoteEscrow balance). Distinct from
///         {DelegationMint}: that one is a CONTINUOUS per-block accumulator; this is a DISCRETE,
///         per-epoch SNAPSHOT mint — your share is `epochEmission * yourWeight / totalWeight` of the
///         epoch, paid as freshly minted bonded tokens.
///
/// @dev THE SNAPSHOT PROBLEM AND HOW WE SOLVE IT (read carefully):
///      Per-account weights cannot be enumerated on-chain — a snapshot() could only record the
///      TOTAL, and Solidity cannot read an account's PAST weight at claim time (no historical state
///      reads). We solve it exactly like {BribeMarket}: a self-served per-account CHECKPOINT.
///        1. During an epoch, each participant calls `register()` — we read their CURRENT weight
///           from the source and add it to that epoch's running total. One registration per epoch.
///        2. After the epoch ends (a later epoch has begun), they call `claimMint(epoch)` and are
///           paid from the frozen registered numbers: epochEmission(epoch) * yourWeight / total.
///      => UX: YOU MUST `register()` EVERY EPOCH YOU WANT TO EARN. Not registering = earn nothing
///         for that epoch (your weight is simply not in the total). This is honest and unavoidable
///         given the no-historical-reads constraint; it's the same trade-off BribeMarket documents.
contract BondedMintToken is ERC20 {
    IWeightSource public immutable weightSource;
    /// @notice Seconds per epoch. epoch index = block.timestamp / epochLength.
    uint256 public immutable epochLength;
    /// @notice Deploy timestamp's epoch index — epoch 0 of this mint (emission decays from here).
    uint256 public immutable startEpoch;
    /// @notice Emission for the start epoch, before any decay.
    uint256 public immutable baseEmission;
    /// @notice Per-epoch decay in basis points (e.g. 100 = 1% less each epoch).
    uint256 public immutable decayBps;

    uint256 private constant BPS = 10_000;

    /// @notice epoch => total registered weight (sum over participants who registered that epoch).
    mapping(uint256 => uint256) public epochTotalWeight;
    /// @notice epoch => account => weight registered for that epoch (0 = not registered).
    mapping(uint256 => mapping(address => uint256)) public registeredWeight;
    /// @notice epoch => account => already minted flag.
    mapping(uint256 => mapping(address => bool)) public claimed;

    event Registered(uint256 indexed epoch, address indexed account, uint256 weight, uint256 newTotal);
    event Claimed(uint256 indexed epoch, address indexed account, uint256 amount);

    error ZeroAddress();
    error BadParams();
    error AlreadyRegistered();
    error NoWeight();
    error EpochNotEnded();
    error NotRegistered();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(
        string memory name_,
        string memory symbol_,
        IWeightSource weightSource_,
        uint256 epochLength_,
        uint256 baseEmission_,
        uint256 decayBps_
    ) ERC20(name_, symbol_) {
        if (address(weightSource_) == address(0)) revert ZeroAddress();
        if (epochLength_ == 0 || baseEmission_ == 0 || decayBps_ >= BPS) revert BadParams();
        weightSource = weightSource_;
        epochLength = epochLength_;
        baseEmission = baseEmission_;
        decayBps = decayBps_;
        startEpoch = block.timestamp / epochLength_;
    }

    /// @notice Current absolute epoch index.
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLength;
    }

    /// @notice Emission for a given absolute `epoch`, after geometric decay from the start epoch.
    /// @dev epochEmission = baseEmission * ((BPS - decayBps)/BPS) ^ (epoch - startEpoch). Returns 0
    ///      for any epoch before the start epoch.
    function epochEmission(uint256 epoch) public view returns (uint256 emission) {
        if (epoch < startEpoch) return 0;
        emission = baseEmission;
        uint256 steps = epoch - startEpoch;
        uint256 keep = BPS - decayBps;
        for (uint256 i = 0; i < steps; i++) {
            emission = (emission * keep) / BPS;
        }
    }

    /// @notice Register the caller's CURRENT weight for the current epoch so they share its mint.
    /// @dev Must be re-called every epoch (see contract notes). One registration per (epoch, caller).
    function register() external returns (uint256 weight) {
        uint256 epoch = currentEpoch();
        if (registeredWeight[epoch][msg.sender] != 0) revert AlreadyRegistered();
        weight = weightSource.weightOf(msg.sender);
        if (weight == 0) revert NoWeight();

        registeredWeight[epoch][msg.sender] = weight;
        uint256 newTotal = epochTotalWeight[epoch] + weight;
        epochTotalWeight[epoch] = newTotal;
        emit Registered(epoch, msg.sender, weight, newTotal);
    }

    /// @notice The amount the caller could mint for a (now-ended) `epoch` (0 if ineligible/claimed).
    function claimableMint(uint256 epoch, address account) public view returns (uint256) {
        if (epoch >= currentEpoch()) return 0;
        if (claimed[epoch][account]) return 0;
        uint256 w = registeredWeight[epoch][account];
        uint256 total = epochTotalWeight[epoch];
        if (w == 0 || total == 0) return 0;
        return (epochEmission(epoch) * w) / total;
    }

    /// @notice Mint the caller's pro-rata share of a PAST epoch's emission from their registration.
    /// @dev Epoch must have ended (a later epoch begun). Single claim per (epoch, caller).
    function claimMint(uint256 epoch) external returns (uint256 amount) {
        if (epoch >= currentEpoch()) revert EpochNotEnded();
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();
        uint256 w = registeredWeight[epoch][msg.sender];
        if (w == 0) revert NotRegistered();
        uint256 total = epochTotalWeight[epoch];

        amount = (epochEmission(epoch) * w) / total;
        if (amount == 0) revert NothingToClaim();

        claimed[epoch][msg.sender] = true;
        _mint(msg.sender, amount);
        emit Claimed(epoch, msg.sender, amount);
    }
}
