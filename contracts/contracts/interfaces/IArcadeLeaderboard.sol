// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IArcadeLeaderboard — attester-signed per-season high-score boards with prize pools.
/// @notice External surface of {ArcadeLeaderboard}: admins register a game (top-N size, season
///         length, signer, rank payout weights); an off-chain attester signs EIP-712 score
///         vouchers that anyone can post; funders top up a (game, season) prize pool; ranked
///         players claim their weighted share once the season ends.
interface IArcadeLeaderboard {
    struct Entry {
        address player;
        uint256 score;
    }

    event GameRegistered(bytes32 indexed gameId, uint8 topN, uint64 seasonLength, address attester);
    event AttesterUpdated(bytes32 indexed gameId, address attester);
    event RankBpsUpdated(bytes32 indexed gameId, uint16[] rankBps);
    event ScorePosted(bytes32 indexed gameId, uint256 indexed season, address indexed player, uint256 score, uint256 rank);
    event PoolFunded(bytes32 indexed gameId, uint256 indexed season, address indexed funder, uint256 amount);
    event PrizeClaimed(bytes32 indexed gameId, uint256 indexed season, uint256 indexed rank, address player, uint256 amount);
    event PoolSwept(bytes32 indexed gameId, uint256 indexed season, address indexed to, uint256 amount);
    event SweepGraceUpdated(uint256 sweepGrace);

    function BPS_DENOM() external view returns (uint16);
    function MAX_TOP_N() external view returns (uint8);
    function sweepGrace() external view returns (uint256);
    function usedNonce(bytes32 gameId, uint256 nonce) external view returns (bool);
    function rankClaimed(bytes32 gameId, uint256 season, uint256 rank) external view returns (bool);

    // --- admin ------------------------------------------------------------ //
    function registerGame(
        bytes32 gameId,
        uint8 topN,
        uint64 seasonLength,
        address attester,
        uint16[] calldata rankBps
    ) external;
    function setAttester(bytes32 gameId, address attester) external;
    function setRankBps(bytes32 gameId, uint16[] calldata rankBps) external;
    function setSweepGrace(uint256 sweepGrace_) external;

    // --- views ------------------------------------------------------------ //
    function currentSeason(bytes32 gameId) external view returns (uint256);
    function getGame(bytes32 gameId)
        external
        view
        returns (uint8 topN, uint64 seasonLength, address attester, uint16[] memory rankBps);
    function getBoard(bytes32 gameId, uint256 season) external view returns (Entry[] memory);
    function getPool(bytes32 gameId, uint256 season)
        external
        view
        returns (address token, uint256 total, bool finalized);
    function hashScore(
        address player,
        bytes32 gameId,
        uint256 season,
        uint256 score,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32);

    // --- mutators --------------------------------------------------------- //
    function postScore(
        address player,
        bytes32 gameId,
        uint256 season,
        uint256 score,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external;
    function fundPool(bytes32 gameId, uint256 season, IERC20 token, uint256 amount) external;
    function claimPrize(bytes32 gameId, uint256 season, uint256 rank) external;
    function sweepPool(bytes32 gameId, uint256 season, address to) external;
}
