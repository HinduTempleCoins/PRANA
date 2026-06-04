// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITaskRegistry} from "../interfaces/ITaskRegistry.sol";

/// @dev The extra (beyond ITaskRegistry) reads this policy needs from {TaskRegistry} to enumerate
///      and rank the catalog. {TaskRegistry} implements all of these.
interface ITaskRegistryEnumerable is ITaskRegistry {
    function allTaskIds() external view returns (bytes32[] memory);
    function taskCount() external view returns (uint256);
    function taskIdAt(uint256 i) external view returns (bytes32);
    function priorityOf(bytes32 taskId) external view returns (uint256);
    function isKnown(bytes32 taskId) external view returns (bool);
}

/// @title TaskDispatchPolicy (backlog RR2) — DAO-settable routing/priority over the task catalog.
/// @notice Sits on top of {TaskRegistry} and produces the EFFECTIVE dispatch priority used to route
///         workers to task-types. Effective priority = the registry's base priority + an optional
///         governed per-task BOOST + the "anchor reservation" boost (if active). Only ENABLED
///         task-types are ranked.
///
/// @dev THE ANCHOR RESERVATION (the "Hathor-priority-for-≥1yr" mechanism):
///      Progressive decentralization still wants to GUARANTEE a flagship workload (Hathor) top
///      routing priority for a published window without permanently hard-coding it. The anchor is a
///      single governed, EXPIRABLE entry: `{ taskId, boost, expiry }`. While `block.timestamp <
///      expiry` the anchor's `taskId` gets `+boost` added to its effective priority; at/after
///      `expiry` the boost VANISHES automatically (no transaction needed) and the task falls back to
///      its ordinary governed priority — the reservation is self-expiring, not self-renewing. The
///      DAO can set, re-point, extend, or clear the anchor at any time via {setAnchor}/{clearAnchor};
///      it can never silently outlive its published `expiry`.
///
///      This contract holds no token and moves no value — pure governed routing configuration.
contract TaskDispatchPolicy is AccessControl {
    /// @notice Role permitted to tune routing weights and the anchor (the DAO timelock).
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @notice The governed task catalog this policy ranks.
    ITaskRegistryEnumerable public immutable registry;

    /// @notice Optional per-task additive priority boost set by governance (independent of anchor).
    mapping(bytes32 => uint256) public priorityBoost;

    /// @notice The single expirable anchor reservation.
    struct Anchor {
        bytes32 taskId; // which task-type is reserved priority
        uint256 boost;  // additive priority while active
        uint64 expiry;  // unix timestamp the reservation lapses at (exclusive)
    }
    Anchor public anchor;

    error ZeroRegistry();
    error ZeroTaskId();
    error UnknownTask(bytes32 taskId);
    error ExpiryInPast(uint64 expiry);
    error EmptyCatalog();

    event PriorityBoostSet(bytes32 indexed taskId, uint256 boost);
    event AnchorSet(bytes32 indexed taskId, uint256 boost, uint64 expiry);
    event AnchorCleared(bytes32 indexed previousTaskId);

    /// @param registry_ the {TaskRegistry} (as an enumerable view).
    /// @param admin     bootstrap admin (DEFAULT_ADMIN_ROLE + GOVERNOR_ROLE); hand GOVERNOR_ROLE to
    ///                  the DAO timelock to decentralize.
    constructor(ITaskRegistryEnumerable registry_, address admin) {
        if (address(registry_) == address(0)) revert ZeroRegistry();
        require(admin != address(0), "admin=0");
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------
    // Governed routing config
    // ------------------------------------------------------------------------------------------

    /// @notice Set a per-task additive priority boost (0 clears it). Task must be registered.
    function setPriorityBoost(bytes32 taskId, uint256 boost) external onlyRole(GOVERNOR_ROLE) {
        if (taskId == bytes32(0)) revert ZeroTaskId();
        if (!registry.isKnown(taskId)) revert UnknownTask(taskId);
        priorityBoost[taskId] = boost;
        emit PriorityBoostSet(taskId, boost);
    }

    /// @notice Set/replace the expirable anchor reservation (e.g. Hathor priority for ≥1 year).
    /// @param taskId the reserved task-type (must be registered).
    /// @param boost  additive priority while active.
    /// @param expiry unix timestamp the reservation lapses at; must be in the future.
    function setAnchor(bytes32 taskId, uint256 boost, uint64 expiry) external onlyRole(GOVERNOR_ROLE) {
        if (taskId == bytes32(0)) revert ZeroTaskId();
        if (!registry.isKnown(taskId)) revert UnknownTask(taskId);
        if (expiry <= block.timestamp) revert ExpiryInPast(expiry);
        anchor = Anchor({taskId: taskId, boost: boost, expiry: expiry});
        emit AnchorSet(taskId, boost, expiry);
    }

    /// @notice Clear the anchor reservation immediately (before its natural expiry).
    function clearAnchor() external onlyRole(GOVERNOR_ROLE) {
        bytes32 prev = anchor.taskId;
        delete anchor;
        emit AnchorCleared(prev);
    }

    // ------------------------------------------------------------------------------------------
    // Effective-priority reads + ranking
    // ------------------------------------------------------------------------------------------

    /// @notice Whether the anchor reservation is currently active (set and not yet expired).
    function anchorActive() public view returns (bool) {
        return anchor.taskId != bytes32(0) && block.timestamp < anchor.expiry;
    }

    /// @notice The additive anchor boost applied to `taskId` right now (0 unless it's the active
    ///         anchor's task). Self-expiring: returns 0 at/after `anchor.expiry` with no tx needed.
    function activeAnchorBoost(bytes32 taskId) public view returns (uint256) {
        if (anchorActive() && anchor.taskId == taskId) return anchor.boost;
        return 0;
    }

    /// @notice Effective dispatch priority of `taskId` = base priority + governed boost + anchor.
    /// @dev Disabled task-types still report their numeric effective priority here (the caller/
    ///      ranking filters on enabled); use {isEnabled} via the registry to gate routing.
    function effectivePriority(bytes32 taskId) public view returns (uint256) {
        uint256 base = registry.priorityOf(taskId);
        return base + priorityBoost[taskId] + activeAnchorBoost(taskId);
    }

    /// @notice Rank all ENABLED task-types by descending effective priority (selection sort over the
    ///         catalog). Returns parallel arrays of ids and their effective priorities.
    /// @dev O(n^2) over the catalog — intended for off-chain reads / small governed catalogs, not a
    ///      hot on-chain path. Reverts {EmptyCatalog} only if NO task-types are registered at all;
    ///      if some are registered but none enabled it returns empty arrays.
    function rankedEnabled()
        external
        view
        returns (bytes32[] memory ids, uint256[] memory priorities)
    {
        bytes32[] memory all = registry.allTaskIds();
        if (all.length == 0) revert EmptyCatalog();

        // First pass: collect enabled ids + their effective priorities.
        uint256 n;
        for (uint256 i = 0; i < all.length; i++) {
            if (registry.isEnabled(all[i])) n++;
        }
        ids = new bytes32[](n);
        priorities = new uint256[](n);
        uint256 k;
        for (uint256 i = 0; i < all.length; i++) {
            if (registry.isEnabled(all[i])) {
                ids[k] = all[i];
                priorities[k] = effectivePriority(all[i]);
                k++;
            }
        }

        // Selection sort descending by priority (stable enough for governed ranking).
        for (uint256 i = 0; i < n; i++) {
            uint256 best = i;
            for (uint256 j = i + 1; j < n; j++) {
                if (priorities[j] > priorities[best]) best = j;
            }
            if (best != i) {
                (priorities[i], priorities[best]) = (priorities[best], priorities[i]);
                (ids[i], ids[best]) = (ids[best], ids[i]);
            }
        }
    }

    /// @notice The single highest-effective-priority ENABLED task-type (the next to dispatch).
    /// @dev Reverts {EmptyCatalog} if no enabled task-types exist.
    function topTask() external view returns (bytes32 topId, uint256 topPriority) {
        bytes32[] memory all = registry.allTaskIds();
        bool found;
        for (uint256 i = 0; i < all.length; i++) {
            if (!registry.isEnabled(all[i])) continue;
            uint256 p = effectivePriority(all[i]);
            if (!found || p > topPriority) {
                found = true;
                topId = all[i];
                topPriority = p;
            }
        }
        if (!found) revert EmptyCatalog();
    }
}
