// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IHumanContributionGate — the one-shot consume()-verdict surface for human contributions.
/// @notice Mirrors {ITaskVerificationGate}'s make-or-break boundary, adapted for HUMAN data work
///         (preference ranks, SFT demonstrations, red-team/eval, annotation, surveys, ...). A
///         contribution claim becomes "verified" only once a quorum of distinct labeler attestations
///         lands AND the known-answer (gold-task/honeypot) and attention/speed checks pass. The lane
///         creditor ({HumanTaskCreditor}) then pulls a fresh, not-yet-consumed verdict — one-shot, so
///         a single verified contribution can only ever be credited into the pool once.
interface IHumanContributionGate {
    /// @notice True once quorum + the gold-task and attention checks have all passed for `claimId`.
    function isVerified(bytes32 claimId) external view returns (bool);

    /// @notice One-shot consume: returns the verified contributor and the lane-native base share
    ///         count bound to the claim, flipping it to consumed. Reverts if not verified / already
    ///         consumed. Gated to a consumer role (the lane creditor holds it).
    function consume(bytes32 claimId) external returns (address contributor, uint256 baseShares);
}
