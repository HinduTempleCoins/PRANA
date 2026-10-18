// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBridgeValidatorSet — membership + quorum surface for the federated bridge validator set.
///
/// @notice MINIMAL read surface the {GrapheneDepositBridge} needs from a validator set. Kept as a
///         SELECTOR-COMPATIBLE SUBSET of the canonical {interfaces/IBridgeValidatorSet} — the same
///         `isValidator` / `threshold` / `validatorCount` selectors the real {FederatedBridgeValidatorSet}
///         implements — so the bridge can be wired to the real set with no revert. (Historically this
///         declared `quorum()` while BI1 shipped `threshold()`; that mismatch reverted every
///         `attestDeposit` once the real set was wired — fixed by aligning on `threshold()`.)
///
/// @dev    The bridge tallies the K-of-N attestation quorum ITSELF (per-deposit, on-chain). It only
///         asks the validator set two questions: "is this address a current validator?" and "what is
///         the current quorum threshold?". This mirrors how {TaskVerificationGate} composes
///         {AttestationStakeSlash}.isActive() while keeping its own per-claim tally.
interface IBridgeValidatorSet {
    /// @notice True if `account` is a current member of the active validator set.
    function isValidator(address account) external view returns (bool);

    /// @notice Number of DISTINCT validator attestations required to finalize a bridge action (K).
    ///         Named `threshold()` to match the canonical {interfaces/IBridgeValidatorSet} and the real
    ///         {FederatedBridgeValidatorSet}.
    function threshold() external view returns (uint256);

    /// @notice Current size of the active validator set (N), for off-chain monitoring.
    function validatorCount() external view returns (uint256);
}
