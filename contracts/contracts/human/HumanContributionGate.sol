// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IHumanContributionGate} from "../interfaces/IHumanContributionGate.sol";

/// @notice Minimal surface this gate needs from {AttestationStakeSlash}: it only reads whether a
///         labeler currently holds enough stake to be "active". We compose that staking module's
///         economic security WITHOUT re-implementing stake/slash accounting (same pattern as
///         {TaskVerificationGate}).
interface IAttestationActive {
    function isActive(address attestor) external view returns (bool);
}

/// @title HumanContributionGate (AG4) — verifies a human contribution before pay.
/// @notice The human mirror of {TaskVerificationGate}. A human data-work contribution (a preference
///         rank, an SFT demonstration, a red-team finding, an annotation batch, ...) becomes
///         "verified" only once ALL of the following hold:
///           1. CONSENSUS / REDUNDANCY: K distinct STAKED-ACTIVE labelers attest the contribution
///              (drawn from a configured eligible-N set);
///           2. GOLD-TASK / HONEYPOT: the known-answer check is marked passed (the contributor got
///              the seeded gold question right — catches bots & inattentive workers);
///           3. ATTENTION / SPEED: the attention/speed check is marked passed (not too-fast / random).
///         Only then does {consume} (one-shot, role-gated) hand the lane creditor the verified
///         contributor + the lane-native base share count, so a single contribution is credited into
///         the pool exactly once. This is the make-or-break trust boundary: a forged human share is
///         worth a real hash share in the unified pool.
/// @dev Composition: labelers attest THROUGH this gate; it reuses {AttestationStakeSlash.isActive}
///      as the stake-at-risk predicate and tallies the K-of-N quorum itself, exactly like
///      {TaskVerificationGate}. The gold-task and attention verdicts are supplied by a CHECKER role
///      (the off-chain pipeline that runs the seeded honeypot + timing heuristics); putting them
///      on-chain as explicit flags keeps {consume} a pure, auditable AND of the three conditions.
contract HumanContributionGate is AccessControl, IHumanContributionGate {
    /// @notice Configures claims and labeler sets (registers N set, K threshold, contributor, shares).
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    /// @notice Marks the gold-task / honeypot and attention/speed check verdicts (off-chain pipeline).
    bytes32 public constant CHECKER_ROLE = keccak256("CHECKER_ROLE");
    /// @notice May atomically consume a verified verdict (the lane creditor holds this).
    bytes32 public constant CONSUMER_ROLE = keccak256("CONSUMER_ROLE");

    /// @notice The staking module whose `isActive()` decides if a labeler's attestation counts.
    IAttestationActive public immutable attestation;

    struct Claim {
        address contributor; // who gets credited if this verifies (zero until opened)
        uint128 baseShares;  // lane-native, equal-weight unit count bound at open time
        uint32 k;            // distinct active labeler attestations required
        uint32 n;            // size of the eligible labeler set
        uint32 count;        // distinct valid attestations so far
        bool goldPassed;     // gold-task / honeypot known-answer check passed
        bool attentionPassed;// attention / speed check passed
        bool consumed;       // verdict already spent by a creditor
    }

    mapping(bytes32 => Claim) private _claims;
    // claimId => labeler => is in the eligible-N set
    mapping(bytes32 => mapping(address => bool)) private _eligible;
    // claimId => labeler => has already attested (distinctness guard)
    mapping(bytes32 => mapping(address => bool)) private _attested;

    event ClaimOpened(bytes32 indexed claimId, address indexed contributor, uint256 baseShares, uint32 k, uint32 n);
    event Attested(bytes32 indexed claimId, address indexed labeler, uint32 count, uint32 k);
    event GoldChecked(bytes32 indexed claimId, bool passed);
    event AttentionChecked(bytes32 indexed claimId, bool passed);
    event Verified(bytes32 indexed claimId, address indexed contributor);
    event Consumed(bytes32 indexed claimId, address indexed contributor, address indexed consumer);

    error ZeroAttestation();
    error ZeroContributor();
    error ZeroBaseShares();
    error BadQuorum(uint32 k, uint32 n);
    error ClaimExists(bytes32 claimId);
    error ClaimUnknown(bytes32 claimId);
    error NotEligible(bytes32 claimId, address labeler);
    error NotActiveLabeler(address labeler);
    error AlreadyAttested(bytes32 claimId, address labeler);
    error AlreadyConsumed(bytes32 claimId);
    error NotVerified(bytes32 claimId);

    constructor(IAttestationActive attestation_, address admin) {
        if (address(attestation_) == address(0)) revert ZeroAttestation();
        require(admin != address(0), "admin=0");
        attestation = attestation_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(CHECKER_ROLE, admin);
    }

    /// @notice Open a contribution claim: bind the contributor, the base shares, the K threshold and
    ///         the eligible-N labeler set.
    /// @dev `labelers` length defines N; K must be in [1, N]. Duplicates are tolerated, counted once.
    function openClaim(
        bytes32 claimId,
        address contributor,
        uint256 baseShares,
        uint32 k,
        address[] calldata labelers
    ) external onlyRole(CONFIG_ROLE) {
        if (contributor == address(0)) revert ZeroContributor();
        if (baseShares == 0) revert ZeroBaseShares();
        if (_claims[claimId].contributor != address(0)) revert ClaimExists(claimId);

        uint32 n;
        {
            mapping(address => bool) storage set = _eligible[claimId];
            uint256 len = labelers.length;
            for (uint256 i; i < len; ++i) {
                address a = labelers[i];
                if (a != address(0) && !set[a]) {
                    set[a] = true;
                    ++n;
                }
            }
        }
        if (k == 0 || k > n) revert BadQuorum(k, n);

        _claims[claimId] = Claim({
            contributor: contributor,
            baseShares: uint128(baseShares),
            k: k,
            n: n,
            count: 0,
            goldPassed: false,
            attentionPassed: false,
            consumed: false
        });
        emit ClaimOpened(claimId, contributor, baseShares, k, n);
    }

    /// @notice An eligible, staked-active labeler attests the contribution. Crossing K + checks emits Verified.
    function attest(bytes32 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.contributor == address(0)) revert ClaimUnknown(claimId);
        if (!_eligible[claimId][msg.sender]) revert NotEligible(claimId, msg.sender);
        if (_attested[claimId][msg.sender]) revert AlreadyAttested(claimId, msg.sender);
        if (!attestation.isActive(msg.sender)) revert NotActiveLabeler(msg.sender);

        _attested[claimId][msg.sender] = true;
        uint32 count = c.count + 1;
        c.count = count;
        emit Attested(claimId, msg.sender, count, c.k);
        if (_isVerified(c)) emit Verified(claimId, c.contributor);
    }

    /// @notice Mark the gold-task / honeypot known-answer check result. CHECKER_ROLE only.
    function setGoldPassed(bytes32 claimId, bool passed) external onlyRole(CHECKER_ROLE) {
        Claim storage c = _claims[claimId];
        if (c.contributor == address(0)) revert ClaimUnknown(claimId);
        c.goldPassed = passed;
        emit GoldChecked(claimId, passed);
        if (_isVerified(c)) emit Verified(claimId, c.contributor);
    }

    /// @notice Mark the attention / speed check result. CHECKER_ROLE only.
    function setAttentionPassed(bytes32 claimId, bool passed) external onlyRole(CHECKER_ROLE) {
        Claim storage c = _claims[claimId];
        if (c.contributor == address(0)) revert ClaimUnknown(claimId);
        c.attentionPassed = passed;
        emit AttentionChecked(claimId, passed);
        if (_isVerified(c)) emit Verified(claimId, c.contributor);
    }

    /// @dev The pure AND of the three conditions (quorum + gold + attention).
    function _isVerified(Claim storage c) internal view returns (bool) {
        return c.contributor != address(0) && c.count >= c.k && c.goldPassed && c.attentionPassed;
    }

    /// @inheritdoc IHumanContributionGate
    function isVerified(bytes32 claimId) public view returns (bool) {
        return _isVerified(_claims[claimId]);
    }

    /// @notice The contributor bound to a claim (zero if never opened).
    function contributorOf(bytes32 claimId) external view returns (address) {
        return _claims[claimId].contributor;
    }

    /// @notice Snapshot of a claim's verification state for off-chain monitoring.
    function claimState(bytes32 claimId)
        external
        view
        returns (
            address contributor,
            uint256 baseShares,
            uint32 k,
            uint32 n,
            uint32 count,
            bool goldPassed,
            bool attentionPassed,
            bool consumed
        )
    {
        Claim storage c = _claims[claimId];
        return (c.contributor, c.baseShares, c.k, c.n, c.count, c.goldPassed, c.attentionPassed, c.consumed);
    }

    /// @inheritdoc IHumanContributionGate
    /// @notice Atomically spend a verified verdict exactly once; returns (contributor, baseShares).
    /// @dev Gated to CONSUMER_ROLE (the lane creditor). Replay guard: a verified contribution can be
    ///      turned into pooled shares only once.
    function consume(bytes32 claimId)
        external
        onlyRole(CONSUMER_ROLE)
        returns (address contributor, uint256 baseShares)
    {
        Claim storage c = _claims[claimId];
        if (c.contributor == address(0)) revert ClaimUnknown(claimId);
        if (c.consumed) revert AlreadyConsumed(claimId);
        if (!_isVerified(c)) revert NotVerified(claimId);
        c.consumed = true;
        contributor = c.contributor;
        baseShares = c.baseShares;
        emit Consumed(claimId, contributor, msg.sender);
    }
}
