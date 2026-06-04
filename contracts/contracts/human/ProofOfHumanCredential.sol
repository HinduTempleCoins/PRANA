// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IProofOfHumanCredential} from "../interfaces/IProofOfHumanCredential.sol";

/// @title ProofOfHumanCredential (AG3) — a verified-human credential WITHOUT heavy KYC.
/// @notice A pluggable VERIFIER role attests that an address belongs to a real, distinct human and
///         records a `provenance` tag (which mechanism vouched for them). The result is a revocable,
///         non-transferable credential read as {isVerifiedHuman}. Anything that pays tradeable tokens
///         (e.g. {HumanTaskCreditor}) gates on this so pooled value never flows to a Sybil farm of
///         fresh addresses.
/// @dev PLUGGABLE BY DESIGN (UD-AG-B): this contract is deliberately agnostic to HOW humanity is
///      proven. The DAO wires whatever VERIFIER(s) it trusts — a captcha-of-record service, a
///      social-graph attestor, a World-ID-style uniqueness proof, an in-person event signer, etc.
///      The concrete mechanism is a USER DECISION (UD-AG-B); this contract only records the verdict
///      and its provenance tag, and supports revocation. No personal data is stored on-chain — only
///      the boolean credential + an opaque provenance tag.
contract ProofOfHumanCredential is AccessControl, IProofOfHumanCredential {
    /// @notice Role permitted to attest / revoke humanity (the pluggable verifier(s)).
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    struct Credential {
        bool verified;       // live credential?
        bytes32 provenance;  // which mechanism vouched (opaque tag)
    }

    mapping(address => Credential) private _cred;

    event HumanVerified(address indexed who, bytes32 indexed provenance, address indexed verifier);
    event HumanRevoked(address indexed who, address indexed verifier);

    error ZeroSubject();
    error ZeroProvenance();
    error NotVerified(address who);

    /// @param admin DEFAULT_ADMIN_ROLE + bootstrap VERIFIER_ROLE holder (DAO grants real verifiers).
    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
    }

    /// @notice Attest that `who` is a verified human, tagging the proving mechanism via `provenance`.
    /// @dev Idempotent: re-verifying updates the provenance tag and re-emits.
    function verify(address who, bytes32 provenance) external onlyRole(VERIFIER_ROLE) {
        if (who == address(0)) revert ZeroSubject();
        if (provenance == bytes32(0)) revert ZeroProvenance();
        _cred[who] = Credential({verified: true, provenance: provenance});
        emit HumanVerified(who, provenance, msg.sender);
    }

    /// @notice Revoke `who`'s human credential (fraud discovered, mechanism deprecated, etc.).
    function revoke(address who) external onlyRole(VERIFIER_ROLE) {
        if (!_cred[who].verified) revert NotVerified(who);
        delete _cred[who];
        emit HumanRevoked(who, msg.sender);
    }

    /// @inheritdoc IProofOfHumanCredential
    function isVerifiedHuman(address who) external view returns (bool) {
        return _cred[who].verified;
    }

    /// @inheritdoc IProofOfHumanCredential
    function provenanceOf(address who) external view returns (bytes32) {
        return _cred[who].provenance;
    }
}
