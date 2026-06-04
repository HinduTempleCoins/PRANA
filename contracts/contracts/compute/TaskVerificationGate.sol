// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal surface this gate needs from AttestationStakeSlash: it only reads whether an
///         attestor currently holds enough stake to be "active". We compose that staking module's
///         economic security WITHOUT re-implementing stake/slash accounting.
interface IAttestationActive {
    function isActive(address attestor) external view returns (bool);
}

/// @notice The credit-side surface a lane creditor (e.g. TaskLaneCreditor) calls to find out
///         whether a task-completion claim is verified, and to atomically consume that verdict so
///         a single verified claim can only ever be credited once.
interface ITaskVerificationGate {
    function isVerified(bytes32 claimId) external view returns (bool);

    /// @notice One-shot consume: returns the worker bound to a verified, not-yet-consumed claim and
    ///         flips it to consumed. Reverts if not verified or already consumed. Gated to a role.
    function consume(bytes32 claimId) external returns (address worker);
}

/// @title TaskVerificationGate (backlog NN4)
/// @notice K-of-N quorum wrapper layered ON TOP OF AttestationStakeSlash. A task-completion claim
///         becomes "verified" only once K distinct STAKED-ACTIVE attestors (drawn from an admin/
///         registry-configured set of N) attest it. Because a forged TASK share is worth a real
///         HASH share in the unified pool, this gate is the make-or-break trust boundary: the
///         TaskLaneCreditor will not mint pooled shares until isVerified() && consume() succeed.
/// @dev Composition note: AttestationStakeSlash.attest() only emits an event — it records NO
///      on-chain per-claim quorum. So attestors attest THROUGH this gate; the gate re-uses the
///      staking module's `isActive()` as the economic gating predicate (stake-at-risk, slashable
///      out of band by the SLASHER_ROLE on the staking module) and itself tallies the K-of-N
///      quorum on-chain. One claim = one task-completion assertion for a (worker) pair.
contract TaskVerificationGate is AccessControl, ITaskVerificationGate {
    /// @notice Configures claims and attestor sets (registers the N set, K threshold, worker).
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    /// @notice May atomically consume a verified verdict (the lane creditor holds this).
    bytes32 public constant CONSUMER_ROLE = keccak256("CONSUMER_ROLE");

    /// @notice The staking module whose `isActive()` decides if an attestor's voice counts.
    IAttestationActive public immutable attestation;

    struct Claim {
        address worker; // who gets credited if this verifies (zero until opened)
        uint32 k; // distinct active attestations required
        uint32 n; // size of the eligible attestor set
        uint32 count; // distinct valid attestations so far
        bool consumed; // verdict already spent by a creditor
    }

    mapping(bytes32 => Claim) private _claims;
    // claimId => attestor => is in the eligible-N set
    mapping(bytes32 => mapping(address => bool)) private _eligible;
    // claimId => attestor => has already attested (distinctness guard)
    mapping(bytes32 => mapping(address => bool)) private _attested;

    event ClaimOpened(bytes32 indexed claimId, address indexed worker, uint32 k, uint32 n);
    event Attested(bytes32 indexed claimId, address indexed attestor, uint32 count, uint32 k);
    event Verified(bytes32 indexed claimId, address indexed worker);
    event Consumed(bytes32 indexed claimId, address indexed worker, address indexed consumer);

    error ZeroAttestation();
    error ZeroWorker();
    error BadQuorum(uint32 k, uint32 n);
    error ClaimExists(bytes32 claimId);
    error ClaimUnknown(bytes32 claimId);
    error NotEligible(bytes32 claimId, address attestor);
    error NotActiveAttestor(address attestor);
    error AlreadyAttested(bytes32 claimId, address attestor);
    error AlreadyConsumed(bytes32 claimId);
    error NotVerified(bytes32 claimId);

    constructor(IAttestationActive attestation_, address admin) {
        if (address(attestation_) == address(0)) revert ZeroAttestation();
        require(admin != address(0), "admin=0");
        attestation = attestation_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
    }

    /// @notice Open a claim: register the worker, the K threshold and the eligible-N attestor set.
    /// @dev `attestors` length defines N; K must be in [1, N]. Duplicates in `attestors` are
    ///      tolerated but counted once toward N.
    function openClaim(bytes32 claimId, address worker, uint32 k, address[] calldata attestors)
        external
        onlyRole(CONFIG_ROLE)
    {
        if (worker == address(0)) revert ZeroWorker();
        if (_claims[claimId].worker != address(0)) revert ClaimExists(claimId);

        uint32 n;
        {
            mapping(address => bool) storage set = _eligible[claimId];
            uint256 len = attestors.length;
            for (uint256 i; i < len; ++i) {
                address a = attestors[i];
                if (a != address(0) && !set[a]) {
                    set[a] = true;
                    ++n;
                }
            }
        }
        if (k == 0 || k > n) revert BadQuorum(k, n);

        _claims[claimId] = Claim({worker: worker, k: k, n: n, count: 0, consumed: false});
        emit ClaimOpened(claimId, worker, k, n);
    }

    /// @notice An eligible, staked-active attestor attests the claim. Crossing K emits Verified.
    /// @dev Re-uses AttestationStakeSlash.isActive(msg.sender) so only stake-at-risk attestors
    ///      count; distinctness is enforced per (claim, attestor).
    function attest(bytes32 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.worker == address(0)) revert ClaimUnknown(claimId);
        if (!_eligible[claimId][msg.sender]) revert NotEligible(claimId, msg.sender);
        if (_attested[claimId][msg.sender]) revert AlreadyAttested(claimId, msg.sender);
        if (!attestation.isActive(msg.sender)) revert NotActiveAttestor(msg.sender);

        _attested[claimId][msg.sender] = true;
        uint32 count = c.count + 1;
        c.count = count;
        emit Attested(claimId, msg.sender, count, c.k);
        if (count == c.k) emit Verified(claimId, c.worker);
    }

    /// @notice True once at least K distinct active attestations have landed (independent of
    ///         consumption — see consume() for the one-shot spend).
    function isVerified(bytes32 claimId) public view returns (bool) {
        Claim storage c = _claims[claimId];
        return c.worker != address(0) && c.count >= c.k;
    }

    /// @notice The worker bound to a claim (zero if the claim was never opened).
    function workerOf(bytes32 claimId) external view returns (address) {
        return _claims[claimId].worker;
    }

    /// @notice (k, n, count, consumed) snapshot for off-chain monitoring.
    function quorumOf(bytes32 claimId)
        external
        view
        returns (uint32 k, uint32 n, uint32 count, bool consumed)
    {
        Claim storage c = _claims[claimId];
        return (c.k, c.n, c.count, c.consumed);
    }

    /// @notice Atomically spend a verified verdict exactly once; returns the bound worker.
    /// @dev Gated to CONSUMER_ROLE (the lane creditor). This is the replay guard that stops a
    ///      single verified claim from being credited into the pool twice.
    function consume(bytes32 claimId) external onlyRole(CONSUMER_ROLE) returns (address worker) {
        Claim storage c = _claims[claimId];
        if (c.worker == address(0)) revert ClaimUnknown(claimId);
        if (c.consumed) revert AlreadyConsumed(claimId);
        if (c.count < c.k) revert NotVerified(claimId);
        c.consumed = true;
        worker = c.worker;
        emit Consumed(claimId, worker, msg.sender);
    }
}
