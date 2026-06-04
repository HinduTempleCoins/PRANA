// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBridgeValidatorSet — membership + quorum surface for the federated bridge validator set.
///
/// @notice ⚠️ MINIMAL LOCAL PLACEHOLDER. The canonical {FederatedBridgeValidatorSet} (backlog BI1)
///         is being built by a sibling agent. This interface declares only the read surface the
///         {GrapheneDepositBridge} needs so the two can be wired without a hard dependency on BI1's
///         storage layout. When BI1 lands, point the bridge at its address — if BI1 exposes a
///         different selector set, ORCHESTRATOR should reconcile this interface with BI1's actual
///         external surface (or have BI1 implement these exact selectors).
///
/// @dev    The bridge tallies the K-of-N attestation quorum ITSELF (per-deposit, on-chain). It only
///         asks the validator set two questions: "is this address a current validator?" and "what is
///         the current quorum threshold?". This mirrors how {TaskVerificationGate} composes
///         {AttestationStakeSlash}.isActive() while keeping its own per-claim tally.
interface IBridgeValidatorSet {
    /// @notice True if `account` is a current member of the active validator set.
    function isValidator(address account) external view returns (bool);

    /// @notice Number of distinct validator attestations required to finalize a bridge action (K).
    function quorum() external view returns (uint256);

    /// @notice Current size of the active validator set (N), for off-chain monitoring.
    function validatorCount() external view returns (uint256);
}
