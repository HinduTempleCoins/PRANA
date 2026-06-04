// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IUnifiedSharesLedger} from "../interfaces/IUnifiedSharesLedger.sol";
import {IWorkerBeacon} from "../interfaces/IWorkerBeacon.sol";

/// @title HashLaneCreditor (backlog NN2)
/// @notice Role-gated adapter the off-chain pool coordinator calls to batch-credit hash work into
///         the unified pool's HASH lane. The coordinator computes vardiff-normalized share counts
///         off-chain (so every accepted share is worth the same on-chain regardless of a worker's
///         difficulty) and submits `(worker, hashShares)[]` per epoch via submitBatch().
/// @dev Trust model: HASH credit is NOT verification-gated — a hash share is self-evidently work
///      (the coordinator already validated the PoW share off-chain, same as any pool). The guards
///      here are operational: (1) only CREDITOR_ROLE may submit; (2) a (epoch, batchId) pair can
///      be submitted at most once (replay/double-pay guard); (3) if a WorkerBeaconRegistry is
///      configured, the worker must be bound (skip when zero-address = open mode).
contract HashLaneCreditor is AccessControl {
    /// @notice The off-chain coordinator key(s) allowed to submit normalized hash batches.
    bytes32 public constant CREDITOR_ROLE = keccak256("CREDITOR_ROLE");

    /// @notice The canonical pool ledger; we only ever credit Lane.HASH.
    IUnifiedSharesLedger public immutable ledger;

    /// @notice Optional worker-eligibility oracle; zero address disables the bind check.
    IWorkerBeacon public beacon;

    /// @notice epoch => batchId => submitted (replay guard).
    mapping(uint256 => mapping(bytes32 => bool)) public batchSubmitted;

    event BeaconSet(address indexed beacon);
    event BatchCredited(
        uint256 indexed epoch, bytes32 indexed batchId, uint256 workers, uint256 totalShares
    );
    event HashCredited(uint256 indexed epoch, address indexed worker, uint256 shares);

    error ZeroLedger();
    error LengthMismatch(uint256 workers, uint256 shares);
    error EmptyBatch();
    error BatchAlreadySubmitted(uint256 epoch, bytes32 batchId);
    error ZeroWorker(uint256 index);
    error ZeroShares(uint256 index);
    error WorkerNotBound(address worker);

    constructor(IUnifiedSharesLedger ledger_, IWorkerBeacon beacon_, address admin) {
        if (address(ledger_) == address(0)) revert ZeroLedger();
        require(admin != address(0), "admin=0");
        ledger = ledger_;
        beacon = beacon_; // may be zero (open mode)
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CREDITOR_ROLE, admin);
        emit BeaconSet(address(beacon_));
    }

    /// @notice Admin can wire/unwire the WorkerBeaconRegistry after deploy (sibling builds it).
    function setBeacon(IWorkerBeacon beacon_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        beacon = beacon_;
        emit BeaconSet(address(beacon_));
    }

    /// @notice Batch-credit vardiff-normalized hash shares for a single epoch.
    /// @param epoch The epoch these shares belong to (coordinator-asserted; the ledger applies its
    ///        own current-epoch accounting on creditShares — see note below).
    /// @param batchId A coordinator-chosen id unique per (epoch); replay-guarded.
    /// @param workers Parallel array of worker addresses.
    /// @param hashShares Parallel array of already-normalized share counts (equal-weight units).
    /// @dev NOTE on epoch: IUnifiedSharesLedger.creditShares() credits the ledger's CURRENT epoch.
    ///      `epoch` here is the coordinator's accounting key for the replay guard and event index;
    ///      the coordinator is expected to submit a batch within the epoch it accounts for. We do
    ///      not silently re-bucket: the (epoch, batchId) guard is the integrity primitive.
    function submitBatch(
        uint256 epoch,
        bytes32 batchId,
        address[] calldata workers,
        uint256[] calldata hashShares
    ) external onlyRole(CREDITOR_ROLE) {
        uint256 len = workers.length;
        if (len != hashShares.length) revert LengthMismatch(len, hashShares.length);
        if (len == 0) revert EmptyBatch();
        if (batchSubmitted[epoch][batchId]) revert BatchAlreadySubmitted(epoch, batchId);

        batchSubmitted[epoch][batchId] = true;

        IWorkerBeacon b = beacon;
        bool checkBound = address(b) != address(0);

        uint256 total;
        for (uint256 i; i < len; ++i) {
            address worker = workers[i];
            uint256 shares = hashShares[i];
            if (worker == address(0)) revert ZeroWorker(i);
            if (shares == 0) revert ZeroShares(i);
            if (checkBound && !b.isBound(worker)) revert WorkerNotBound(worker);

            ledger.creditShares(worker, IUnifiedSharesLedger.Lane.HASH, shares);
            total += shares;
            emit HashCredited(epoch, worker, shares);
        }

        emit BatchCredited(epoch, batchId, len, total);
    }
}
