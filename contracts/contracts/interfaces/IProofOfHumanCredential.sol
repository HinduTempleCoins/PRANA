// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IProofOfHumanCredential — minimal "is this address a verified human?" surface.
/// @notice A verified-human credential WITHOUT heavy KYC. A pluggable VERIFIER role attests that
///         an address belongs to a real, distinct human (via whatever provenance mechanism the DAO
///         wires — captcha-of-record, social attestation, World-ID-style proof, in-person event,
///         etc. — UD-AG-B leaves the concrete mechanism open). Consumers that pay tradeable tokens
///         (e.g. {HumanTaskCreditor}) read {isVerifiedHuman} as a hard gate so pooled value only
///         ever flows to attested humans, never to a Sybil farm of fresh addresses.
interface IProofOfHumanCredential {
    /// @notice True once `who` holds a live (non-revoked) human credential.
    function isVerifiedHuman(address who) external view returns (bool);

    /// @notice The provenance tag of `who`'s credential (which mechanism attested them); 0 if none.
    function provenanceOf(address who) external view returns (bytes32);
}
