// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {WeightedRandomDraw} from "./lib/WeightedRandomDraw.sol";

/// @title ScoutDiscovery — passive, clue-gated exploration that surfaces world discoveries
/// @notice A player dispatches a scout into a zone with a *clue* they prove they hold by
///         committing its hash up front (GachaMintOnCommit-style salt pattern): dispatch takes
///         keccak256(clue) and resolve later takes the clue pre-image. Only one scout per
///         player per zone may be active at a time. After a per-zone block cadence elapses,
///         resolve() draws a discovery from that zone's admin-set discovery table via
///         {WeightedRandomDraw}, seeded from a future blockhash mixed with the player and the
///         revealed clue. Each discoverable has a `maxFinds` depletion budget; once exhausted
///         it is skipped (re-normalized out of the draw). Discoveries are emitted as events
///         carrying an opaque `ref` — this contract does NOT mint; consumer contracts holding
///         a role elsewhere act on the events / a fulfillment hook.
/// @dev    The clue-commit closes the same grinding hole GachaMintOnCommit documents: the clue
///         hash is fixed before the seed blockhash is known, and the blockhash is fixed before
///         the clue is revealed, so neither a colluding miner nor the player can search the
///         outcome. A discoverable with weight 0 OR depleted maxFinds is never selected.
contract ScoutDiscovery is AccessControl {
    using WeightedRandomDraw for uint256[];

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Reveal target is dispatchBlock + cadence; blockhash leaves the 256-block
    ///         lookback `EXPIRY_BLOCKS` after that target, after which the scout must be recalled.
    uint256 public constant EXPIRY_BLOCKS = 256;

    enum Kind { NodeReveal, HiddenDoorway, FragmentDrop }

    struct Discoverable {
        Kind kind;       // discovery category (for the consumer to interpret)
        bytes32 ref;     // opaque reference the consumer resolves (a node id, doorway id, ...)
        uint256 weight;  // draw weight
        uint256 maxFinds; // depletion budget (0 = unlimited)
        uint256 finds;   // how many times already discovered
    }

    struct Zone {
        bool exists;
        uint256 cadenceBlocks; // blocks a scout must roam before resolve is allowed
    }

    struct Scout {
        uint256 dispatchBlock; // block.number at dispatch (0 = no active scout)
        bytes32 clueHash;      // keccak256(abi.encodePacked(clue)) committed at dispatch
    }

    /// @dev zoneId => zone config.
    mapping(uint256 => Zone) public zones;
    /// @dev zoneId => discovery table.
    mapping(uint256 => Discoverable[]) private _tables;
    /// @dev zoneId => player => active scout.
    mapping(uint256 => mapping(address => Scout)) public scouts;

    event ZoneConfigured(uint256 indexed zoneId, uint256 cadenceBlocks);
    event DiscoverableAdded(uint256 indexed zoneId, uint256 indexed index, uint8 kind, bytes32 ref, uint256 weight, uint256 maxFinds);
    event ScoutDispatched(uint256 indexed zoneId, address indexed player, uint256 dispatchBlock, bytes32 clueHash);
    event ScoutRecalled(uint256 indexed zoneId, address indexed player);
    event Discovered(uint256 indexed zoneId, address indexed player, uint256 indexed index, uint8 kind, bytes32 ref);
    event NothingFound(uint256 indexed zoneId, address indexed player);

    error ZeroAddress();
    error ZoneExists(uint256 zoneId);
    error UnknownZone(uint256 zoneId);
    error BadCadence();
    error ZeroWeight();
    error ScoutActive(uint256 zoneId);
    error NoScout(uint256 zoneId);
    error ZeroClueHash();
    error TooEarly();
    error TooLate();
    error BadClue();
    error EmptyTable(uint256 zoneId);

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //  Admin: zones & discovery tables                                      //
    // --------------------------------------------------------------------- //

    /// @notice Create a zone with a resolve cadence (blocks a scout must roam).
    function configureZone(uint256 zoneId, uint256 cadenceBlocks) external onlyRole(ADMIN_ROLE) {
        if (zones[zoneId].exists) revert ZoneExists(zoneId);
        if (cadenceBlocks == 0) revert BadCadence();
        zones[zoneId] = Zone({exists: true, cadenceBlocks: cadenceBlocks});
        emit ZoneConfigured(zoneId, cadenceBlocks);
    }

    /// @notice Append a discoverable to a zone's table.
    /// @param maxFinds Depletion budget (0 = unlimited finds).
    function addDiscoverable(
        uint256 zoneId,
        Kind kind,
        bytes32 ref,
        uint256 weight,
        uint256 maxFinds
    ) external onlyRole(ADMIN_ROLE) {
        if (!zones[zoneId].exists) revert UnknownZone(zoneId);
        if (weight == 0) revert ZeroWeight();
        Discoverable[] storage tbl = _tables[zoneId];
        uint256 index = tbl.length;
        tbl.push(Discoverable({kind: kind, ref: ref, weight: weight, maxFinds: maxFinds, finds: 0}));
        emit DiscoverableAdded(zoneId, index, uint8(kind), ref, weight, maxFinds);
    }

    /// @notice Number of discoverables configured in a zone.
    function tableLength(uint256 zoneId) external view returns (uint256) {
        return _tables[zoneId].length;
    }

    /// @notice Read a single discoverable entry.
    function discoverableAt(uint256 zoneId, uint256 index)
        external
        view
        returns (Kind kind, bytes32 ref, uint256 weight, uint256 maxFinds, uint256 finds)
    {
        Discoverable storage d = _tables[zoneId][index];
        return (d.kind, d.ref, d.weight, d.maxFinds, d.finds);
    }

    /// @notice Whether a discoverable is depleted (finds reached maxFinds).
    function isDepleted(uint256 zoneId, uint256 index) public view returns (bool) {
        Discoverable storage d = _tables[zoneId][index];
        return d.maxFinds != 0 && d.finds >= d.maxFinds;
    }

    // --------------------------------------------------------------------- //
    //  Dispatch / resolve                                                   //
    // --------------------------------------------------------------------- //

    /// @notice Helper to compute the clue hash a caller must pass to {dispatch}. Keep the clue
    ///         pre-image secret until {resolve}.
    function clueHashOf(bytes32 clue) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(clue));
    }

    /// @notice Dispatch a scout into a zone, gated by a clue you commit by hash. One active
    ///         scout per player per zone.
    /// @param zoneId   Target zone.
    /// @param clueHash keccak256(abi.encodePacked(clue)) for a clue only the caller knows. The
    ///        same clue pre-image must be supplied to {resolve}. Must be non-zero.
    function dispatch(uint256 zoneId, bytes32 clueHash) external {
        if (!zones[zoneId].exists) revert UnknownZone(zoneId);
        if (clueHash == bytes32(0)) revert ZeroClueHash();
        if (scouts[zoneId][msg.sender].dispatchBlock != 0) revert ScoutActive(zoneId);

        scouts[zoneId][msg.sender] = Scout({dispatchBlock: block.number, clueHash: clueHash});
        emit ScoutDispatched(zoneId, msg.sender, block.number, clueHash);
    }

    /// @notice Resolve a dispatched scout once its cadence has elapsed: verify the clue, draw a
    ///         discovery (depletion-aware), emit it, deplete it, and free the scout slot.
    /// @param zoneId Zone the scout is roaming.
    /// @param clue   The secret pre-image whose keccak256 was committed at dispatch.
    /// @return found Whether a (non-depleted) discovery was made.
    /// @return index Index of the discovered entry (meaningful only when `found`).
    function resolve(uint256 zoneId, bytes32 clue) external returns (bool found, uint256 index) {
        Scout memory s = scouts[zoneId][msg.sender];
        if (s.dispatchBlock == 0) revert NoScout(zoneId);
        if (keccak256(abi.encodePacked(clue)) != s.clueHash) revert BadClue();

        bytes32 bh = _seedBlockhash(zoneId, s.dispatchBlock);

        // Effects: free the scout slot before emitting.
        delete scouts[zoneId][msg.sender];

        uint256 entropy = uint256(keccak256(abi.encodePacked(bh, msg.sender, clue, zoneId)));
        (found, index) = _drawAvailable(zoneId, entropy);

        if (found) {
            Discoverable storage d = _tables[zoneId][index];
            d.finds += 1;
            emit Discovered(zoneId, msg.sender, index, uint8(d.kind), d.ref);
        } else {
            emit NothingFound(zoneId, msg.sender);
        }
    }

    /// @notice Recall a scout whose reveal window has expired (its seed blockhash left the
    ///         lookback), freeing the slot for a fresh dispatch without resolving.
    function recall(uint256 zoneId) external {
        Scout memory s = scouts[zoneId][msg.sender];
        if (s.dispatchBlock == 0) revert NoScout(zoneId);
        uint256 revealBlock = s.dispatchBlock + zones[zoneId].cadenceBlocks;
        if (block.number <= revealBlock + EXPIRY_BLOCKS) revert TooEarly();
        delete scouts[zoneId][msg.sender];
        emit ScoutRecalled(zoneId, msg.sender);
    }

    /// @notice The block.number at which a player's scout in a zone becomes resolvable.
    function resolvableAt(uint256 zoneId, address player) external view returns (uint256) {
        Scout storage s = scouts[zoneId][player];
        if (s.dispatchBlock == 0) return 0;
        return s.dispatchBlock + zones[zoneId].cadenceBlocks;
    }

    // --------------------------------------------------------------------- //
    //  Internal helpers                                                     //
    // --------------------------------------------------------------------- //

    /// @dev The seed blockhash for a scout: blockhash(dispatchBlock + cadence). Reverts
    ///      TooEarly before that block is mined and TooLate once it leaves the lookback window.
    function _seedBlockhash(uint256 zoneId, uint256 dispatchBlock) internal view returns (bytes32) {
        uint256 revealBlock = dispatchBlock + zones[zoneId].cadenceBlocks;
        if (block.number <= revealBlock) revert TooEarly();
        bytes32 bh = blockhash(revealBlock);
        if (bh == bytes32(0)) revert TooLate();
        return bh;
    }

    /// @dev Draw an available (non-depleted, non-zero-weight) discoverable from a zone's table.
    ///      Builds a depletion-filtered weight vector and draws over it, so depleted entries are
    ///      correctly re-normalized out. Returns found=false if every entry is depleted.
    function _drawAvailable(uint256 zoneId, uint256 entropy)
        internal
        view
        returns (bool found, uint256 index)
    {
        Discoverable[] storage tbl = _tables[zoneId];
        uint256 len = tbl.length;
        if (len == 0) revert EmptyTable(zoneId);

        uint256[] memory w = new uint256[](len);
        uint256 total;
        for (uint256 i = 0; i < len; i++) {
            if (!isDepleted(zoneId, i)) {
                w[i] = tbl[i].weight;
                total += tbl[i].weight;
            }
        }
        if (total == 0) return (false, 0);
        return (true, w.draw(entropy));
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
