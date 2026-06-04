// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IContributionSource — adapter surface over a single contribution-verification module.
/// @notice The ProofOfContributionRouter (BI10) routes a TYPED contribution (COMPUTE | SOLAR | CODE)
///         through the adapter registered for that kind. The adapter is the ONLY place that knows the
///         shape of its underlying source module (ComputeJobMarket / ProofOfSolarOracleMint /
///         ContributionBountyEscrow); it asks that module to confirm the proof is verified and returns
///         a NORMALIZED credit. The router never re-implements verification — it delegates here, and
///         the adapter delegates to the real module.
/// @dev Each adapter MUST be a pure read-through over its source: given a `proofId` and opaque
///      `data`, it returns the beneficiary `account` and a lane-native `baseAmount` (unweighted).
///      It MUST revert if the proof is not verified / not settled in the underlying module, so a
///      forged contribution can never produce a credit. The router applies the per-source weight and
///      enforces dedup itself; the adapter is stateless w.r.t. routing.
interface IContributionSource {
    /// @notice Confirm a verified contribution and return its normalized credit.
    /// @param proofId The source-module-native identifier of the contribution (job id, solar proof
    ///        hash, bounty id, ...), passed through opaquely by the router for dedup keying.
    /// @param data    ABI-encoded source-specific payload the adapter needs to look the proof up.
    /// @return account   The beneficiary the credit must be routed to (source-bound, not caller-set).
    /// @return baseAmount The lane-native (unweighted) contribution amount; the router weights it.
    function verifyContribution(bytes32 proofId, bytes calldata data)
        external
        view
        returns (address account, uint256 baseAmount);
}
