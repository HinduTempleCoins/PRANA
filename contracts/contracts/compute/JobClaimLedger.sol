// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {CoordinatorRegistry} from "./CoordinatorRegistry.sol";

/// @title JobClaimLedger (PR2) — cross-coordinator job dedup (§14).
/// @notice In the decentralized-pool model ANY operator may run a coordinator (see
///         {CoordinatorRegistry}). That openness creates a double-spend surface: the SAME unit of
///         useful work (a job) could be claimed and settled by two different coordinators for double
///         shares. This ledger is the single, chain-wide arbiter of "who claimed which job first" so
///         a job can be turned into pooled shares at most once across the whole network.
///
/// @dev A job is keyed by `bytes32 jobId` — by convention keccak256 of the (normalized) job spec plus
///      a nonce, so identical work hashes to the same id regardless of which coordinator saw it. The
///      lifecycle:
///        claim(jobId, worker)  → first caller wins; second claim of the same id reverts AlreadyClaimed.
///        settle(jobId)         → the claiming coordinator marks the credit final (permanent; cannot be
///                                 released). Call this once the share has actually been credited to the
///                                 ledger so the claim can never be recycled.
///        release(jobId)        → if a coordinator claims but never settles (it dropped offline), the
///                                 claim can be released after `claimWindow` so the work isn't stranded;
///                                 the job then becomes claimable again by anyone authorized.
///
///      AUTHORIZATION: claiming is gated to coordinators. Two complementary paths, either suffices:
///        (a) the caller is an active, bonded coordinator in the wired {CoordinatorRegistry} (PR1) —
///            the permissionless path; OR
///        (b) the caller holds AUTHORIZED_COORDINATOR (an explicit role grant) — an escape hatch for a
///            registry-less deployment or a privileged on-chain settlement module.
///      If no registry is wired (address(0)), only path (b) applies. settle/release are restricted to
///      the claimant of that specific job (so one coordinator cannot settle/release another's claim),
///      and the claimant must still be authorized at the time it acts.
contract JobClaimLedger is AccessControl {
    /// @notice Explicit coordinator authorization (path b) — a registry-less / module override.
    bytes32 public constant AUTHORIZED_COORDINATOR = keccak256("AUTHORIZED_COORDINATOR");
    /// @notice May set the registry pointer and the claim window. The DAO timelock in production.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    /// @notice Optional permissionless allowlist (PR1). address(0) disables path (a).
    CoordinatorRegistry public registry;

    /// @notice Seconds after which an unsettled claim may be released by anyone authorized.
    uint256 public claimWindow;

    /// @notice Per-job claim record.
    struct Job {
        address claimant; // coordinator that claimed it (zero = unclaimed/released)
        address worker; // worker the job was claimed for (informational / payout target)
        uint64 claimedAt; // unix ts of the claim (for the release window)
        bool settled; // terminal: credit finalized, can never be released or re-claimed
    }

    /// @dev jobId => record.
    mapping(bytes32 => Job) private _jobs;

    event JobClaimed(bytes32 indexed jobId, address indexed coordinator, address indexed worker, uint64 claimedAt);
    event JobSettled(bytes32 indexed jobId, address indexed coordinator);
    event JobReleased(bytes32 indexed jobId, address indexed releaser, address indexed priorClaimant);
    event RegistrySet(address indexed registry);
    event ClaimWindowSet(uint256 claimWindow);

    error ZeroJobId();
    error ZeroWorker();
    error NotAuthorizedCoordinator(address caller);
    error AlreadyClaimed(bytes32 jobId, address claimant);
    error AlreadySettled(bytes32 jobId);
    error NotClaimed(bytes32 jobId);
    error NotClaimant(bytes32 jobId, address caller);
    error ClaimWindowNotElapsed(bytes32 jobId, uint64 releasableAt);

    /// @param registry_    the CoordinatorRegistry allowlist (may be address(0) to use role-only mode).
    /// @param admin        DEFAULT_ADMIN_ROLE + CONFIG_ROLE holder (DAO timelock in prod).
    /// @param claimWindow_ seconds before an unsettled claim may be released.
    constructor(CoordinatorRegistry registry_, address admin, uint256 claimWindow_) {
        require(admin != address(0), "admin=0");
        registry = registry_; // may be zero (role-only mode)
        claimWindow = claimWindow_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);

        emit RegistrySet(address(registry_));
        emit ClaimWindowSet(claimWindow_);
    }

    // --------------------------------------------------------------------- //
    //                            authorization                              //
    // --------------------------------------------------------------------- //

    /// @notice True if `caller` may claim/settle/release: an active registry coordinator OR a holder
    ///         of AUTHORIZED_COORDINATOR.
    function isAuthorizedCoordinator(address caller) public view returns (bool) {
        if (hasRole(AUTHORIZED_COORDINATOR, caller)) return true;
        CoordinatorRegistry reg = registry;
        return address(reg) != address(0) && reg.isActiveCoordinator(caller);
    }

    function _requireAuthorized(address caller) internal view {
        if (!isAuthorizedCoordinator(caller)) revert NotAuthorizedCoordinator(caller);
    }

    // --------------------------------------------------------------------- //
    //                          claim / settle / release                     //
    // --------------------------------------------------------------------- //

    /// @notice Claim `jobId` for `worker`; the first authorized coordinator to call wins. A second
    ///         claim of the same id (while claimed-and-unsettled, or settled) reverts AlreadyClaimed.
    /// @dev A released job (claimant cleared, not settled) is claimable again — see {release}.
    function claim(bytes32 jobId, address worker) external {
        if (jobId == bytes32(0)) revert ZeroJobId();
        if (worker == address(0)) revert ZeroWorker();
        _requireAuthorized(msg.sender);

        Job storage j = _jobs[jobId];
        if (j.settled) revert AlreadySettled(jobId);
        if (j.claimant != address(0)) revert AlreadyClaimed(jobId, j.claimant);

        uint64 nowTs = uint64(block.timestamp);
        j.claimant = msg.sender;
        j.worker = worker;
        j.claimedAt = nowTs;
        emit JobClaimed(jobId, msg.sender, worker, nowTs);
    }

    /// @notice Mark a claimed job's credit as final (permanent). Only the claiming, still-authorized
    ///         coordinator may settle. After this the job can never be released or re-claimed.
    function settle(bytes32 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.claimant == address(0)) revert NotClaimed(jobId);
        if (j.settled) revert AlreadySettled(jobId);
        if (j.claimant != msg.sender) revert NotClaimant(jobId, msg.sender);
        _requireAuthorized(msg.sender);

        j.settled = true;
        emit JobSettled(jobId, msg.sender);
    }

    /// @notice Release a claimed-but-unsettled job after the claim window so dropped work isn't
    ///         stranded. Callable by the original claimant at any time, or by any authorized
    ///         coordinator once `claimWindow` has elapsed. Clears the claimant; the job is claimable
    ///         again. Settled jobs cannot be released.
    function release(bytes32 jobId) external {
        Job storage j = _jobs[jobId];
        address prior = j.claimant;
        if (prior == address(0)) revert NotClaimed(jobId);
        if (j.settled) revert AlreadySettled(jobId);
        _requireAuthorized(msg.sender);

        // The claimant can always relinquish early; others must wait out the window.
        if (msg.sender != prior) {
            uint64 releasableAt = j.claimedAt + uint64(claimWindow);
            if (block.timestamp < releasableAt) revert ClaimWindowNotElapsed(jobId, releasableAt);
        }

        j.claimant = address(0);
        j.worker = address(0);
        j.claimedAt = 0;
        emit JobReleased(jobId, msg.sender, prior);
    }

    // --------------------------------------------------------------------- //
    //                          governed setters                             //
    // --------------------------------------------------------------------- //

    function setRegistry(CoordinatorRegistry registry_) external onlyRole(CONFIG_ROLE) {
        registry = registry_; // may be set to zero to fall back to role-only mode
        emit RegistrySet(address(registry_));
    }

    function setClaimWindow(uint256 claimWindow_) external onlyRole(CONFIG_ROLE) {
        claimWindow = claimWindow_;
        emit ClaimWindowSet(claimWindow_);
    }

    // --------------------------------------------------------------------- //
    //                                views                                  //
    // --------------------------------------------------------------------- //

    /// @notice True if `jobId` is currently claimed (claimed-and-unsettled, or settled).
    function isClaimed(bytes32 jobId) external view returns (bool) {
        Job storage j = _jobs[jobId];
        return j.claimant != address(0) || j.settled;
    }

    /// @notice True once `jobId` has been settled (permanently finalized).
    function isSettled(bytes32 jobId) external view returns (bool) {
        return _jobs[jobId].settled;
    }

    /// @notice The coordinator currently holding `jobId` (zero if unclaimed/released; the settler if
    ///         settled — the claimant field is retained through settle()).
    function claimantOf(bytes32 jobId) external view returns (address) {
        return _jobs[jobId].claimant;
    }

    /// @notice The worker `jobId` was claimed for (zero if unclaimed/released).
    function workerOf(bytes32 jobId) external view returns (address) {
        return _jobs[jobId].worker;
    }

    /// @notice Timestamp at which a claimed-but-unsettled job becomes releasable by others
    ///         (0 if unclaimed/released/settled).
    function releasableAt(bytes32 jobId) external view returns (uint64) {
        Job storage j = _jobs[jobId];
        if (j.claimant == address(0) || j.settled) return 0;
        return j.claimedAt + uint64(claimWindow);
    }
}
