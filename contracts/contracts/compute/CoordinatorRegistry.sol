// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CoordinatorRegistry (PR1) — permissionless pool-coordinator registry with slashable bond.
/// @notice "The chain IS the pool, but ANYONE may run a coordinator." Instead of a DAO hand-granting
///         the ledger's TASK_CREDITOR role to a blessed few, this registry lets ANY operator stand up
///         a pool coordinator (the Hive/BLURT-front-end + P2Pool model) by posting a slashable bond.
///         The set of registered, active, unslashed coordinators is the permissionless allowlist the
///         TASK-lane settlement path consults before crediting useful-work (AI/scientific) shares.
///
/// @dev GATING MODEL (the design choice — documented so the wiring is unambiguous):
///      This contract is a **guard / allowlist**, NOT a forwarder. The on-chain TASK settlement
///      module (`TaskLaneCreditor`) keeps the ledger's `TASK_CREDITOR` role and keeps all of its
///      verification logic (it pulls a K-of-N verified verdict out of `TaskVerificationGate` and
///      binds the recipient to the gate-bound worker — callers cannot redirect credit). What this
///      registry adds is a permissionless *operator* gate: the creditor (or the off-chain coordinator
///      key that drives it) is required to be a bonded, active coordinator here. We expose:
///        * {isActiveCoordinator} — a cheap view the creditor checks, and
///        * {requireActiveCoordinator} — a reverting guard (NotActiveCoordinator) the creditor calls.
///      Chosen over a forwarder because a forwarder would have to re-implement / re-route the
///      verification-gate consume() flow, risking a double-credit seam; a pure allowlist composes
///      with the existing, audited creditor->gate->ledger path with zero new value flow. The only
///      value this contract ever moves is bonds (in on register/top-up, out on cooldown-withdraw,
///      or to the treasury on slash).
///
///      WHY HASH NEEDS NO BOND: microhash (HASH lane) shares self-verify — a submitted PoW share is
///      self-evidently work that the coordinator already validated off-chain (same trust model as any
///      classic mining pool). There is nothing to lie about that a bond would deter, so HASH-lane
///      coordinators are intentionally NOT required to register or bond here. This registry exists
///      specifically for the TASK lane, where a forged "useful-work" share is worth a real hash share
///      and off-chain accounting must be put at economic risk.
contract CoordinatorRegistry is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice May slash a coordinator's bond on proven fake-work, and adjust registry params
    ///         (minBond, cooldown, treasury). The DAO timelock / challenge process in production.
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @notice The bond asset (e.g. native PRANA). 18-dec; wei under the hood.
    IERC20 public immutable bondToken;

    /// @notice Minimum bond a coordinator must post to be active. SLASHER_ROLE/admin governed.
    uint256 public minBond;

    /// @notice Seconds a deregistering coordinator must wait after requesting exit before it can
    ///         withdraw its bond (gives challengers a window to slash on late-surfacing fraud).
    uint256 public cooldown;

    /// @notice Where slashed bonds are routed (the DAO/treasury). Never address(0).
    address public treasury;

    /// @notice Per-coordinator record. `active` is the live allowlist flag; `slashed` is terminal.
    struct Coordinator {
        uint256 bond; // currently-posted bond (slashable)
        uint64 exitRequestedAt; // unix ts of deregister() request; 0 = not exiting
        bool registered; // has ever registered (record exists)
        bool active; // counts toward the allowlist (false once exiting/slashed)
        bool slashed; // terminal: proven fake-work; can never re-activate or withdraw
        string metadataURI; // optional off-chain pool info (endpoint, fee, contact)
    }

    /// @dev coordinator address => record.
    mapping(address => Coordinator) private _coordinators;

    event CoordinatorRegistered(address indexed coordinator, uint256 bond, string metadataURI);
    event BondToppedUp(address indexed coordinator, uint256 added, uint256 newBond);
    event MetadataUpdated(address indexed coordinator, string metadataURI);
    event DeregisterRequested(address indexed coordinator, uint64 withdrawableAt);
    event Deregistered(address indexed coordinator, uint256 bondReturned);
    event CoordinatorSlashed(address indexed coordinator, uint256 amount, address indexed treasury);
    event MinBondSet(uint256 minBond);
    event CooldownSet(uint256 cooldown);
    event TreasurySet(address indexed treasury);

    error ZeroAddress();
    error ZeroAmount();
    error BondBelowMinimum(uint256 posted, uint256 minBond);
    error AlreadyRegistered(address coordinator);
    error NotRegistered(address coordinator);
    error NotActiveCoordinator(address coordinator);
    error AlreadySlashed(address coordinator);
    error NotExiting(address coordinator);
    error ExitAlreadyRequested(address coordinator);
    error CooldownNotElapsed(uint64 withdrawableAt);
    error SlashExceedsBond(uint256 amount, uint256 bond);

    /// @param bondToken_ the slashable bond asset (e.g. PRANA).
    /// @param admin      DEFAULT_ADMIN_ROLE + SLASHER_ROLE holder (DAO timelock in prod).
    /// @param treasury_  slashed-bond sink (nonzero).
    /// @param minBond_   minimum active bond (may be 0 to bootstrap, raise via setMinBond).
    /// @param cooldown_  deregistration cooldown in seconds.
    constructor(
        IERC20 bondToken_,
        address admin,
        address treasury_,
        uint256 minBond_,
        uint256 cooldown_
    ) {
        if (address(bondToken_) == address(0) || admin == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        bondToken = bondToken_;
        treasury = treasury_;
        minBond = minBond_;
        cooldown = cooldown_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);

        emit TreasurySet(treasury_);
        emit MinBondSet(minBond_);
        emit CooldownSet(cooldown_);
    }

    // --------------------------------------------------------------------- //
    //                           registration                                //
    // --------------------------------------------------------------------- //

    /// @notice Register msg.sender as a coordinator by posting a bond of at least {minBond}.
    /// @param bondAmount the PRANA bond to lock (>= minBond). Pulled via SafeERC20.
    /// @param metadataURI optional off-chain pool descriptor (endpoint/fee/contact); may be empty.
    function register(uint256 bondAmount, string calldata metadataURI) external nonReentrant {
        Coordinator storage c = _coordinators[msg.sender];
        if (c.registered) revert AlreadyRegistered(msg.sender);
        if (bondAmount < minBond) revert BondBelowMinimum(bondAmount, minBond);
        if (bondAmount == 0) revert ZeroAmount();

        c.bond = bondAmount;
        c.registered = true;
        c.active = true;
        c.metadataURI = metadataURI;

        bondToken.safeTransferFrom(msg.sender, address(this), bondAmount);
        emit CoordinatorRegistered(msg.sender, bondAmount, metadataURI);
    }

    /// @notice Add to an existing coordinator's bond (e.g. to clear a raised minBond or rebuild after
    ///         a partial slash). Allowed while not slashed and not mid-exit.
    function topUpBond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Coordinator storage c = _coordinators[msg.sender];
        if (!c.registered) revert NotRegistered(msg.sender);
        if (c.slashed) revert AlreadySlashed(msg.sender);
        if (c.exitRequestedAt != 0) revert ExitAlreadyRequested(msg.sender);

        uint256 newBond = c.bond + amount;
        c.bond = newBond;

        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        emit BondToppedUp(msg.sender, amount, newBond);
    }

    /// @notice Update the off-chain metadata URI for an active coordinator.
    function setMetadataURI(string calldata metadataURI) external {
        Coordinator storage c = _coordinators[msg.sender];
        if (!c.registered) revert NotRegistered(msg.sender);
        if (c.slashed) revert AlreadySlashed(msg.sender);
        c.metadataURI = metadataURI;
        emit MetadataUpdated(msg.sender, metadataURI);
    }

    // --------------------------------------------------------------------- //
    //                          deregistration                               //
    // --------------------------------------------------------------------- //

    /// @notice Begin exiting: immediately drops out of the active allowlist and starts the cooldown.
    /// @dev Going inactive at request time (not at withdraw) means a coordinator cannot keep settling
    ///      shares during its own challenge/cooldown window.
    function requestDeregister() external {
        Coordinator storage c = _coordinators[msg.sender];
        if (!c.registered) revert NotRegistered(msg.sender);
        if (c.slashed) revert AlreadySlashed(msg.sender);
        if (c.exitRequestedAt != 0) revert ExitAlreadyRequested(msg.sender);

        c.active = false;
        uint64 nowTs = uint64(block.timestamp);
        c.exitRequestedAt = nowTs;
        uint64 withdrawableAt = nowTs + uint64(cooldown);
        emit DeregisterRequested(msg.sender, withdrawableAt);
    }

    /// @notice After the cooldown elapses, withdraw the full bond and clear the record. Only if the
    ///         coordinator is unslashed and actually requested an exit.
    function withdrawBond() external nonReentrant {
        Coordinator storage c = _coordinators[msg.sender];
        if (!c.registered) revert NotRegistered(msg.sender);
        if (c.slashed) revert AlreadySlashed(msg.sender);
        uint64 requestedAt = c.exitRequestedAt;
        if (requestedAt == 0) revert NotExiting(msg.sender);

        uint64 withdrawableAt = requestedAt + uint64(cooldown);
        if (block.timestamp < withdrawableAt) revert CooldownNotElapsed(withdrawableAt);

        uint256 amount = c.bond;
        // Clear the record (single-exit; a fresh register() is required to come back).
        delete _coordinators[msg.sender];

        if (amount > 0) bondToken.safeTransfer(msg.sender, amount);
        emit Deregistered(msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    //                               slashing                                //
    // --------------------------------------------------------------------- //

    /// @notice Slash up to a coordinator's full bond on proven fake-work and deactivate it. Slashed
    ///         funds route to the treasury; the coordinator becomes terminally inactive (cannot
    ///         re-activate or withdraw the remainder — it must `register()` afresh after a full slash,
    ///         and a partial slash leaves it deactivated/blocked from withdrawal forever).
    /// @dev A full slash (amount == bond) zeroes the bond. A partial slash keeps `slashed=true` so the
    ///      coordinator is permanently out; this is intentional — slashing is a fraud verdict, not a fee.
    function slash(address coordinator, uint256 amount) external onlyRole(SLASHER_ROLE) nonReentrant {
        Coordinator storage c = _coordinators[coordinator];
        if (!c.registered) revert NotRegistered(coordinator);
        if (c.slashed) revert AlreadySlashed(coordinator);
        if (amount == 0) revert ZeroAmount();
        if (amount > c.bond) revert SlashExceedsBond(amount, c.bond);

        c.bond -= amount;
        c.active = false;
        c.slashed = true;

        address sink = treasury;
        bondToken.safeTransfer(sink, amount);
        emit CoordinatorSlashed(coordinator, amount, sink);
    }

    // --------------------------------------------------------------------- //
    //                          governed setters                             //
    // --------------------------------------------------------------------- //

    function setMinBond(uint256 minBond_) external onlyRole(SLASHER_ROLE) {
        minBond = minBond_;
        emit MinBondSet(minBond_);
    }

    function setCooldown(uint256 cooldown_) external onlyRole(SLASHER_ROLE) {
        cooldown = cooldown_;
        emit CooldownSet(cooldown_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // --------------------------------------------------------------------- //
    //                                guard                                  //
    // --------------------------------------------------------------------- //

    /// @notice The allowlist predicate the TASK-lane creditor checks: true iff `coordinator` is a
    ///         registered, active, unslashed coordinator holding at least the current minBond.
    /// @dev minBond is re-checked live so raising it can soft-gate under-bonded coordinators until
    ///      they top up (without forcing an on-chain sweep).
    function isActiveCoordinator(address coordinator) public view returns (bool) {
        Coordinator storage c = _coordinators[coordinator];
        return c.registered && c.active && !c.slashed && c.bond >= minBond;
    }

    /// @notice Reverting form of {isActiveCoordinator} for use as an inline guard in the creditor.
    function requireActiveCoordinator(address coordinator) external view {
        if (!isActiveCoordinator(coordinator)) revert NotActiveCoordinator(coordinator);
    }

    // --------------------------------------------------------------------- //
    //                                views                                  //
    // --------------------------------------------------------------------- //

    /// @notice Full record for a coordinator (zero-struct if never registered).
    function coordinatorOf(address coordinator)
        external
        view
        returns (
            uint256 bond,
            uint64 exitRequestedAt,
            bool registered,
            bool active,
            bool slashed,
            string memory metadataURI
        )
    {
        Coordinator storage c = _coordinators[coordinator];
        return (c.bond, c.exitRequestedAt, c.registered, c.active, c.slashed, c.metadataURI);
    }

    /// @notice Currently-posted bond of a coordinator.
    function bondOf(address coordinator) external view returns (uint256) {
        return _coordinators[coordinator].bond;
    }

    /// @notice Timestamp at which a deregistering coordinator may withdraw (0 if not exiting).
    function withdrawableAt(address coordinator) external view returns (uint64) {
        uint64 requestedAt = _coordinators[coordinator].exitRequestedAt;
        return requestedAt == 0 ? 0 : requestedAt + uint64(cooldown);
    }
}
