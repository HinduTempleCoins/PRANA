// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IUnifiedSharesLedger} from "../interfaces/IUnifiedSharesLedger.sol";
import {IHumanTaskRegistry} from "../interfaces/IHumanTaskRegistry.sol";
import {IHumanContributionGate} from "../interfaces/IHumanContributionGate.sol";
import {IProofOfHumanCredential} from "../interfaces/IProofOfHumanCredential.sol";
import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";

/// @title HumanTaskCreditor (AG5) — verified human contribution → TASK-lane shares.
/// @notice The human mirror of {TaskLaneCreditor}. Converts a VERIFIED human contribution into
///         TASK-lane shares in the unified pool, at the human task-type's governed weight — letting
///         useful HUMAN data-work (RLHF preference, SFT, eval, annotation, ...) earn pool value
///         side-by-side with hashing and AI compute. This is the half of the engine that pays people
///         for training data.
/// @dev Make-or-break gate ordering (a forged human share is worth a real hash share):
///        (1) consume the gate verdict (one-shot; reverts if unverified/replayed) → binds contributor
///            and the lane-native base shares;
///        (2) require {ProofOfHumanCredential.isVerifiedHuman(contributor)} — no Sybil farms of fresh
///            addresses can be paid tradeable tokens;
///        (3) require {ReputationRegistry.tierOf(contributor)} >= the task's {minReputation} tier;
///        (4) read the governed shareWeight (task must be enabled, weight nonzero);
///        (5) credit weighted shares to the gate-bound contributor — recipient is NOT caller-chosen.
///      The recipient is bound by the gate, not passed by the caller, so credit cannot be redirected.
///
/// @dev LEDGER WIRING (UD-AG-A): human work is credited into the EXISTING `Lane.TASK` of the
///      {UnifiedSharesLedger} — NO new HUMAN ledger lane is added (per the build directive). This
///      contract must therefore hold the ledger's `TASK_CREDITOR` role. Whether human work should
///      instead get its OWN ledger lane (separating human vs AI-compute accounting) is a USER
///      DECISION (UD-AG-A) deferred to governance; this creditor works unchanged either way because
///      the lane is named here, not in the ledger.
///
///      ⚠ ORCHESTRATOR ROLE GRANT REQUIRED (so this contract can credit the pool):
///        unifiedSharesLedger.grantRole(unifiedSharesLedger.TASK_CREDITOR(), address(humanTaskCreditor));
///        humanContributionGate.grantRole(humanContributionGate.CONSUMER_ROLE(), address(humanTaskCreditor));
///      Note: {TaskLaneCreditor} (AI compute) ALSO holds TASK_CREDITOR — both legitimately credit the
///      same lane; the lane just needs both as creditors. This contract does NOT modify the ledger.
contract HumanTaskCreditor is AccessControl {
    /// @notice The off-chain coordinator key allowed to settle verified contributions into the pool.
    bytes32 public constant CREDITOR_ROLE = keccak256("CREDITOR_ROLE");
    uint256 internal constant WAD = 1e18;

    IUnifiedSharesLedger public immutable ledger;
    IHumanTaskRegistry public immutable registry;
    IHumanContributionGate public immutable gate;
    IProofOfHumanCredential public immutable humanCredential;
    IReputationRegistry public immutable reputation;

    event HumanContributionCredited(
        bytes32 indexed claimId,
        bytes32 indexed taskId,
        address indexed contributor,
        uint256 baseShares,
        uint256 weight,
        uint256 weightedShares
    );

    error ZeroLedger();
    error ZeroRegistry();
    error ZeroGate();
    error ZeroCredential();
    error ZeroReputation();
    error NotVerifiedHuman(address contributor);
    error TaskDisabled(bytes32 taskId);
    error ZeroWeight(bytes32 taskId);
    error ZeroWeightedShares();
    error InsufficientReputation(address contributor, uint256 tier, uint256 required);

    constructor(
        IUnifiedSharesLedger ledger_,
        IHumanTaskRegistry registry_,
        IHumanContributionGate gate_,
        IProofOfHumanCredential humanCredential_,
        IReputationRegistry reputation_,
        address admin
    ) {
        if (address(ledger_) == address(0)) revert ZeroLedger();
        if (address(registry_) == address(0)) revert ZeroRegistry();
        if (address(gate_) == address(0)) revert ZeroGate();
        if (address(humanCredential_) == address(0)) revert ZeroCredential();
        if (address(reputation_) == address(0)) revert ZeroReputation();
        require(admin != address(0), "admin=0");
        ledger = ledger_;
        registry = registry_;
        gate = gate_;
        humanCredential = humanCredential_;
        reputation = reputation_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CREDITOR_ROLE, admin);
    }

    /// @notice Settle one verified human contribution into the TASK lane.
    /// @param claimId The verification claim (must be verified and not yet consumed in the gate).
    /// @param taskId  The human task-type whose governed shareWeight + minReputation to apply.
    /// @dev See the contract header for the strict ordering. The base shares come from the gate
    ///      verdict (bound at openClaim), not from the caller, so payout size cannot be inflated here.
    function creditVerified(bytes32 claimId, bytes32 taskId) external onlyRole(CREDITOR_ROLE) {
        // (1) one-shot pull of the verified verdict; reverts unless verified & not consumed.
        (address contributor, uint256 baseShares) = gate.consume(claimId);

        // (2) hard human gate — pooled value never flows to a Sybil farm of fresh addresses.
        if (!humanCredential.isVerifiedHuman(contributor)) revert NotVerifiedHuman(contributor);

        // (3) reputation-tier gate for this task-type.
        uint256 required = registry.minReputation(taskId);
        uint256 tier = reputation.tierOf(contributor);
        if (tier < required) revert InsufficientReputation(contributor, tier, required);

        // (4) governed weight (1e18 = equal-to-hash); task must be enabled, weight nonzero.
        if (!registry.isEnabled(taskId)) revert TaskDisabled(taskId);
        uint256 weight = registry.shareWeight(taskId);
        if (weight == 0) revert ZeroWeight(taskId);

        uint256 weightedShares = (baseShares * weight) / WAD;
        if (weightedShares == 0) revert ZeroWeightedShares();

        // (5) credit the gate-bound contributor into the EXISTING TASK lane (UD-AG-A). NOT caller-controlled.
        ledger.creditShares(contributor, IUnifiedSharesLedger.Lane.TASK, weightedShares);
        emit HumanContributionCredited(claimId, taskId, contributor, baseShares, weight, weightedShares);
    }
}
