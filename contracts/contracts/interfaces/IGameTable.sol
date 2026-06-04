// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "../games/IGameRules.sol";

/// @title IGameTable — the shared staked, turn-based match engine surface.
/// @notice External surface of {GameTable}: matchmaking (create/join/start/cancel), move
///         submission, timeout/draw flows, settlement reads, and the admin rake config. All
///         game-specific logic is delegated to a pluggable {IGameRules} contract; the engine
///         never interprets the opaque state/move bytes.
/// @dev The {Match} struct mirrors the engine's compact per-match record; an integrator reads
///      it via {getMatch}. `winner` semantics: 0 = unsettled, 1..n = that 1-based player won,
///      255 = draw.
interface IGameTable {
    enum Status {
        Open,
        Active,
        Settled,
        Cancelled
    }

    struct Match {
        IGameRules rules;
        address stakeToken;
        uint96 stakeAmount;
        address rakeRecipient;
        uint64 moveTimeout;
        uint64 moveDeadline;
        uint16 rakeBps;
        uint8 minPlayers;
        uint8 maxPlayers;
        uint8 numPlayers;
        uint8 turnIndex;
        uint8 actedMask;
        uint16 startedRound;
        Status status;
        uint8 winner;
    }

    event MatchCreated(
        uint256 indexed id,
        address indexed creator,
        address rules,
        address stakeToken,
        uint256 stakeAmount,
        uint8 minPlayers,
        uint8 maxPlayers
    );
    event PlayerJoined(uint256 indexed id, address indexed player, uint8 numPlayers);
    event MatchStarted(uint256 indexed id, uint8 numPlayers);
    event MoveMade(uint256 indexed id, address indexed player, bytes move);
    event RoundAdvanced(uint256 indexed id, uint16 round);
    event DrawOffered(uint256 indexed id, address indexed player);
    event DrawAccepted(uint256 indexed id, address indexed player);
    event TimeoutClaimed(uint256 indexed id, address indexed stalled, address indexed claimer);
    event MatchSettled(uint256 indexed id, uint8 winner, uint256 payout, uint256 rake);
    event MatchCancelled(uint256 indexed id);
    event DefaultRakeUpdated(uint16 rakeBps, address recipient);

    // --- config / public state ------------------------------------------- //
    function MAX_RAKE_BPS() external view returns (uint16);
    function BPS_DENOMINATOR() external view returns (uint16);
    function nextMatchId() external view returns (uint256);
    function defaultRakeBps() external view returns (uint16);
    function defaultRakeRecipient() external view returns (address);
    function isPlayer(uint256 id, address player) external view returns (bool);
    function drawOffer(uint256 id, address player) external view returns (bool);

    // --- admin ------------------------------------------------------------ //
    function setDefaultRake(uint16 rakeBps_, address rakeRecipient_) external;

    // --- lobby ------------------------------------------------------------ //
    function createMatch(
        IGameRules rules,
        bytes calldata config,
        address stakeToken,
        uint96 stakeAmount,
        uint8 maxPlayers_,
        uint64 moveTimeout
    ) external payable returns (uint256 id);
    function joinMatch(uint256 id) external payable;
    function startMatch(uint256 id) external;
    function cancelMatch(uint256 id) external;

    // --- play ------------------------------------------------------------- //
    function submitMove(uint256 id, bytes calldata move) external;

    // --- timeout / draw --------------------------------------------------- //
    function claimTimeout(uint256 id) external;
    function offerDraw(uint256 id) external;
    function acceptDraw(uint256 id) external;

    // --- views ------------------------------------------------------------ //
    function getMatch(uint256 id) external view returns (Match memory);
    function getState(uint256 id) external view returns (bytes memory);
    function getPlayers(uint256 id) external view returns (address[] memory);
    function currentTurn(uint256 id) external view returns (address);
}
