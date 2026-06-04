// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @dev Minimal interface for a role-gated mintable reward token (PoLToken-style, like the
///      target used by DelegationMint). This contract must hold the minter role on it.
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title CitizenMissionPath — one citizen per player walks a shared mission node graph
/// @notice Admins lay out a directed node graph: each node has an opaque `missionRef`, a
///         `firstClearReward`, a `replayBps` fraction (of the first-clear reward) paid on
///         repeats, a per-player per-day attempt cap, and an adjacency list of edges. Every
///         player has a single citizen with a position on the graph. The citizen {walk}s along
///         edges (gated by adjacency AND a block-cadence between moves), then {attemptMission}s
///         the node it stands on. The FIRST clear *per player* of a node pays the full reward;
///         subsequent replays pay `replayBps/10000` of it. Attempts are capped per player, per
///         node, per day (a day = `dayBlocks` blocks). Each first-clear ranks the citizen up.
/// @dev    Rewards are minted via the {IMintable} role pattern (this contract holds the minter
///         role on `rewardToken`). "First clear" is tracked per (player, node), not globally —
///         the task brief's "first global" was corrected to per-player.
contract CitizenMissionPath is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Bps denominator for replay rewards (10000 = 100%).
    uint256 public constant BPS = 10_000;

    /// @notice The mintable reward token. This contract must hold its minter role.
    IMintable public immutable rewardToken;

    /// @notice Blocks per "day" for the per-node daily attempt cap window.
    uint256 public immutable dayBlocks;

    /// @notice Blocks a citizen must wait between walks (move cadence).
    uint256 public immutable walkCooldownBlocks;

    struct Node {
        bool exists;
        bytes32 missionRef;       // opaque mission identifier for the front-end
        uint256 firstClearReward; // full reward on a player's first clear of this node
        uint256 replayBps;        // fraction (in bps) of firstClearReward paid on replays
        uint256 dailyAttemptCap;  // max attempts per player per day (0 = unlimited)
    }

    /// @dev nodeId => node config.
    mapping(uint256 => Node) public nodes;
    /// @dev nodeId => toNode => edge exists (directed adjacency).
    mapping(uint256 => mapping(uint256 => bool)) public edge;

    struct Citizen {
        bool spawned;       // citizen exists (else position is implicit start node)
        uint256 position;   // current node id
        uint256 rank;       // increments on each first-clear
        uint256 lastWalkBlock; // block of the last walk (for cooldown)
    }

    /// @dev player => citizen.
    mapping(address => Citizen) public citizens;
    /// @dev player => nodeId => already cleared once.
    mapping(address => mapping(uint256 => bool)) public cleared;
    /// @dev player => nodeId => day index => attempts used that day.
    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) public attemptsOnDay;

    /// @notice The node every citizen spawns on (set once at construction).
    uint256 public immutable startNode;

    event NodeConfigured(uint256 indexed nodeId, bytes32 missionRef, uint256 firstClearReward, uint256 replayBps, uint256 dailyAttemptCap);
    event EdgeSet(uint256 indexed fromNode, uint256 indexed toNode, bool enabled);
    event CitizenSpawned(address indexed player, uint256 indexed startNode);
    event Walked(address indexed player, uint256 indexed fromNode, uint256 indexed toNode);
    event MissionCleared(address indexed player, uint256 indexed nodeId, uint256 reward, bool firstClear, uint256 newRank);

    error ZeroAddress();
    error BadParams();
    error UnknownNode(uint256 nodeId);
    error NodeExists(uint256 nodeId);
    error NoEdge(uint256 fromNode, uint256 toNode);
    error WalkOnCooldown(uint256 readyBlock);
    error NotAtNode(uint256 nodeId);
    error DailyCapReached(uint256 nodeId);

    /// @param rewardToken_ Mintable reward token (this contract must hold its minter role).
    /// @param dayBlocks_ Blocks per day window for the attempt cap.
    /// @param walkCooldownBlocks_ Blocks required between walks.
    /// @param startNode_ Node citizens spawn on (must be configured before play).
    /// @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(
        IMintable rewardToken_,
        uint256 dayBlocks_,
        uint256 walkCooldownBlocks_,
        uint256 startNode_,
        address admin
    ) {
        if (address(rewardToken_) == address(0) || admin == address(0)) revert ZeroAddress();
        if (dayBlocks_ == 0) revert BadParams();
        rewardToken = rewardToken_;
        dayBlocks = dayBlocks_;
        walkCooldownBlocks = walkCooldownBlocks_;
        startNode = startNode_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //  Admin: node graph                                                    //
    // --------------------------------------------------------------------- //

    /// @notice Define a node. Each node may be configured once.
    function configureNode(
        uint256 nodeId,
        bytes32 missionRef,
        uint256 firstClearReward,
        uint256 replayBps_,
        uint256 dailyAttemptCap
    ) external onlyRole(ADMIN_ROLE) {
        if (nodes[nodeId].exists) revert NodeExists(nodeId);
        if (replayBps_ > BPS) revert BadParams();
        nodes[nodeId] = Node({
            exists: true,
            missionRef: missionRef,
            firstClearReward: firstClearReward,
            replayBps: replayBps_,
            dailyAttemptCap: dailyAttemptCap
        });
        emit NodeConfigured(nodeId, missionRef, firstClearReward, replayBps_, dailyAttemptCap);
    }

    /// @notice Enable or disable a directed edge from one node to another.
    function setEdge(uint256 fromNode, uint256 toNode, bool enabled) external onlyRole(ADMIN_ROLE) {
        if (!nodes[fromNode].exists) revert UnknownNode(fromNode);
        if (!nodes[toNode].exists) revert UnknownNode(toNode);
        edge[fromNode][toNode] = enabled;
        emit EdgeSet(fromNode, toNode, enabled);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                //
    // --------------------------------------------------------------------- //

    /// @notice The day index the current block falls in (for the attempt-cap window).
    function currentDay() public view returns (uint256) {
        return block.number / dayBlocks;
    }

    /// @notice A player's citizen position (defaults to `startNode` before spawn).
    function positionOf(address player) public view returns (uint256) {
        Citizen storage c = citizens[player];
        return c.spawned ? c.position : startNode;
    }

    /// @notice A player's citizen rank.
    function rankOf(address player) external view returns (uint256) {
        return citizens[player].rank;
    }

    /// @notice Attempts a player has used against a node in the current day window.
    function attemptsToday(address player, uint256 nodeId) external view returns (uint256) {
        return attemptsOnDay[player][nodeId][currentDay()];
    }

    // --------------------------------------------------------------------- //
    //  Walk / attempt                                                       //
    // --------------------------------------------------------------------- //

    /// @dev Lazily materialize a player's citizen on the start node on first interaction.
    function _ensureSpawned(address player) internal returns (Citizen storage c) {
        c = citizens[player];
        if (!c.spawned) {
            c.spawned = true;
            c.position = startNode;
            emit CitizenSpawned(player, startNode);
        }
    }

    /// @notice Walk the caller's citizen to an adjacent node, subject to the move cadence.
    function walk(uint256 toNode) external {
        if (!nodes[toNode].exists) revert UnknownNode(toNode);
        Citizen storage c = _ensureSpawned(msg.sender);

        uint256 from = c.position;
        if (!edge[from][toNode]) revert NoEdge(from, toNode);

        uint256 ready = c.lastWalkBlock + walkCooldownBlocks;
        if (c.lastWalkBlock != 0 && block.number < ready) revert WalkOnCooldown(ready);

        c.position = toNode;
        c.lastWalkBlock = block.number;
        emit Walked(msg.sender, from, toNode);
    }

    /// @notice Attempt the mission at the node the caller's citizen stands on. First clear per
    ///         player pays the full reward and ranks up; replays pay `replayBps` of it. Capped
    ///         per player per node per day.
    /// @return reward The reward minted for this attempt.
    function attemptMission(uint256 nodeId) external returns (uint256 reward) {
        Node storage n = nodes[nodeId];
        if (!n.exists) revert UnknownNode(nodeId);
        if (positionOf(msg.sender) != nodeId) revert NotAtNode(nodeId);

        _consumeDailyAttempt(msg.sender, nodeId, n.dailyAttemptCap);

        bool first = !cleared[msg.sender][nodeId];
        uint256 newRank;
        if (first) {
            cleared[msg.sender][nodeId] = true;
            reward = n.firstClearReward;
            Citizen storage c = _ensureSpawned(msg.sender);
            c.rank += 1;
            newRank = c.rank;
        } else {
            reward = (n.firstClearReward * n.replayBps) / BPS;
            newRank = citizens[msg.sender].rank;
        }

        if (reward > 0) {
            rewardToken.mint(msg.sender, reward);
        }
        emit MissionCleared(msg.sender, nodeId, reward, first, newRank);
    }

    /// @dev Enforce and consume one daily attempt against a node's cap.
    function _consumeDailyAttempt(address player, uint256 nodeId, uint256 cap) internal {
        uint256 day = currentDay();
        uint256 used = attemptsOnDay[player][nodeId][day];
        if (cap != 0 && used >= cap) revert DailyCapReached(nodeId);
        attemptsOnDay[player][nodeId][day] = used + 1;
    }
}
