// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IUnifiedSharesLedger} from "../interfaces/IUnifiedSharesLedger.sol";
import {ITaskRegistry} from "../interfaces/ITaskRegistry.sol";
import {IWorkerBeacon} from "../interfaces/IWorkerBeacon.sol";
import {ITaskVerificationGate} from "./TaskVerificationGate.sol";

/// @title TaskLaneCreditor (backlog NN3)
/// @notice Converts a VERIFIED task completion into TASK-lane shares in the unified pool, at the
///         task-type's governed weight. This is the half of the switching engine that lets useful
///         AI/scientific work earn pool value side-by-side with hashing.
/// @dev Make-or-break gate ordering: a forged task share is worth a real hash share, so we credit
///      ONLY after pulling a fresh verified-and-not-yet-consumed verdict out of the
///      TaskVerificationGate (K-of-N quorum over staked attestors). consume() is one-shot, so a
///      verdict can be turned into pooled shares exactly once. The recipient is the worker the
///      gate bound to the claim — callers cannot redirect credit to an arbitrary address.
///      Weight is read live from ITaskRegistry.shareWeight (1e18 = 1x = equal-to-hash default).
contract TaskLaneCreditor is AccessControl {
    /// @notice The off-chain coordinator key allowed to settle verified completions into the pool.
    bytes32 public constant CREDITOR_ROLE = keccak256("CREDITOR_ROLE");
    uint256 internal constant WAD = 1e18;

    IUnifiedSharesLedger public immutable ledger;
    ITaskRegistry public immutable registry;
    ITaskVerificationGate public immutable gate;

    /// @notice Optional worker-eligibility oracle; zero address disables the bind check.
    IWorkerBeacon public beacon;

    event BeaconSet(address indexed beacon);
    event TaskCredited(
        bytes32 indexed claimId,
        bytes32 indexed taskId,
        address indexed worker,
        uint256 baseShares,
        uint256 weight,
        uint256 weightedShares
    );

    error ZeroLedger();
    error ZeroRegistry();
    error ZeroGate();
    error ZeroBaseShares();
    error TaskDisabled(bytes32 taskId);
    error ZeroWeight(bytes32 taskId);
    error ZeroWeightedShares();
    error WorkerNotBound(address worker);

    constructor(
        IUnifiedSharesLedger ledger_,
        ITaskRegistry registry_,
        ITaskVerificationGate gate_,
        IWorkerBeacon beacon_,
        address admin
    ) {
        if (address(ledger_) == address(0)) revert ZeroLedger();
        if (address(registry_) == address(0)) revert ZeroRegistry();
        if (address(gate_) == address(0)) revert ZeroGate();
        require(admin != address(0), "admin=0");
        ledger = ledger_;
        registry = registry_;
        gate = gate_;
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

    /// @notice Settle one verified task completion into the TASK lane.
    /// @param claimId The verification claim (must be verified and not yet consumed in the gate).
    /// @param taskId The task-type whose governed shareWeight to apply.
    /// @param baseShares The lane-native, equal-weight unit count for this completion (1 = one
    ///        unit of useful work, mirroring one normalized hash share before weighting).
    /// @dev Order: (1) consume the gate verdict (reverts if unverified/replayed) → binds worker;
    ///      (2) read live weight from the registry (must be enabled, nonzero); (3) optional beacon
    ///      bind check; (4) credit weighted shares to the gate-bound worker.
    function creditVerified(bytes32 claimId, bytes32 taskId, uint256 baseShares)
        external
        onlyRole(CREDITOR_ROLE)
    {
        if (baseShares == 0) revert ZeroBaseShares();

        // (1) one-shot pull of the verified verdict; reverts unless verified & not consumed.
        address worker = gate.consume(claimId);

        // (3) optional eligibility check (do it before crediting; cheap revert).
        {
            IWorkerBeacon b = beacon;
            if (address(b) != address(0) && !b.isBound(worker)) revert WorkerNotBound(worker);
        }

        // (2) governed weight (1e18 = equal-to-hash).
        if (!registry.isEnabled(taskId)) revert TaskDisabled(taskId);
        uint256 weight = registry.shareWeight(taskId);
        if (weight == 0) revert ZeroWeight(taskId);

        uint256 weightedShares = (baseShares * weight) / WAD;
        if (weightedShares == 0) revert ZeroWeightedShares();

        // (4) credit the gate-bound worker; recipient is NOT caller-controlled.
        ledger.creditShares(worker, IUnifiedSharesLedger.Lane.TASK, weightedShares);
        emit TaskCredited(claimId, taskId, worker, baseShares, weight, weightedShares);
    }
}
