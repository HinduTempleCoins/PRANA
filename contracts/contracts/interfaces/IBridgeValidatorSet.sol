// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBridgeValidatorSet — minimal read surface of a K-of-N bridge validator set.
/// @notice The federated (stage-3-leaning) replacement for the single-custodian trust model in
///         {IPeggedBridgeVault}. A bridge endpoint (e.g. {CanonicalLockMintBridge}) calls
///         {verifySignatures} to gate a cross-chain action on a quorum of distinct validators
///         having signed an off-chain-produced digest.
///
/// @dev This is the ONLY canonical declaration of this interface — {FederatedBridgeValidatorSet}
///      implements it and {CanonicalLockMintBridge} imports it. Do not redeclare it elsewhere.
interface IBridgeValidatorSet {
    /// @notice True iff `account` is a current member of the validator set.
    function isValidator(address account) external view returns (bool);

    /// @notice The number of DISTINCT valid signatures required to satisfy a quorum (the "K").
    function threshold() external view returns (uint256);

    /// @notice The current size of the validator set (the "N").
    function validatorCount() external view returns (uint256);

    /// @notice Returns true iff `sigs` contains at least {threshold} signatures from DISTINCT
    ///         current validators over `digest`.
    /// @dev    `digest` is expected to already be the final message that validators signed (see the
    ///         implementation for the exact prefixing convention). Implementations MUST reject
    ///         duplicate signers and signatures from non-validators.
    function verifySignatures(bytes32 digest, bytes[] calldata sigs) external view returns (bool);
}
