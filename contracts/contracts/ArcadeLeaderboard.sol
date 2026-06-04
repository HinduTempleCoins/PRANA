// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ArcadeLeaderboard — per-game seasonal leaderboards with attester-signed scores
///         and prize pools.
/// @notice An ADMIN registers each game (a `gameId`, a season length, a top-N size and the
///         game's off-chain ATTESTER signer). The arcade server signs an EIP-712 voucher
///         `(player, gameId, season, score, nonce, deadline)`; anyone may submit it via
///         {postScore}, which verifies the game's attester signed it, burns the single-use
///         nonce and inserts the score into that (game, season)'s fixed-size top-N board.
/// @dev    Top-N is a fixed-length array kept sorted descending by insertion. Each insert is
///         O(topN) (find slot, shift tail down, drop the last entry). With topN ≤ 32 this is a
///         bounded, predictable gas cost; the trade-off vs a heap/linked-list is simplicity and
///         cheap on-chain reads (the board is directly returned) at the cost of O(N) writes.
///
///         Season index is `block.timestamp / seasonLength` — purely time-derived, no keeper.
///         Anyone can fund a (gameId, season) prize pool with an ERC-20; after the season ends
///         (current season index has advanced past it) a ranked player pulls their share via
///         {claimPrize}, split by admin-set rank weights (bps summing to 10000). Unclaimed
///         funds are sweepable by admin only after a grace window past season end.
contract ArcadeLeaderboard is AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    bytes32 public constant SCORE_TYPEHASH = keccak256(
        "Score(address player,bytes32 gameId,uint256 season,uint256 score,uint256 nonce,uint256 deadline)"
    );

    uint16 public constant BPS_DENOM = 10000;
    uint8 public constant MAX_TOP_N = 32;

    struct Game {
        bool registered;
        uint8 topN;
        uint64 seasonLength; // seconds
        address attester;
        uint16[] rankBps; // payout weights by rank (index 0 = 1st place); sums to BPS_DENOM
    }

    struct Entry {
        address player;
        uint256 score;
    }

    struct Pool {
        IERC20 token;
        uint256 total; // funded amount for this (game, season)
        bool finalized; // ranking snapshot frozen at first claim/sweep
    }

    /// @dev gameId => config.
    mapping(bytes32 => Game) private _games;

    /// @dev gameId => season => sorted-descending top-N entries (length ≤ topN).
    mapping(bytes32 => mapping(uint256 => Entry[])) private _board;

    /// @dev gameId => season => prize pool.
    mapping(bytes32 => mapping(uint256 => Pool)) private _pools;

    /// @dev single-use score nonces, namespaced per game.
    mapping(bytes32 => mapping(uint256 => bool)) public usedNonce;

    /// @dev gameId => season => rank => claimed.
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => bool))) public rankClaimed;

    /// @notice Seconds after season end before admin may sweep unclaimed prize funds.
    uint256 public sweepGrace;

    event GameRegistered(bytes32 indexed gameId, uint8 topN, uint64 seasonLength, address attester);
    event AttesterUpdated(bytes32 indexed gameId, address attester);
    event RankBpsUpdated(bytes32 indexed gameId, uint16[] rankBps);
    event ScorePosted(bytes32 indexed gameId, uint256 indexed season, address indexed player, uint256 score, uint256 rank);
    event PoolFunded(bytes32 indexed gameId, uint256 indexed season, address indexed funder, uint256 amount);
    event PrizeClaimed(bytes32 indexed gameId, uint256 indexed season, uint256 indexed rank, address player, uint256 amount);
    event PoolSwept(bytes32 indexed gameId, uint256 indexed season, address indexed to, uint256 amount);
    event SweepGraceUpdated(uint256 sweepGrace);

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyRegistered(bytes32 gameId);
    error NotRegistered(bytes32 gameId);
    error BadTopN(uint8 topN);
    error BadSeasonLength();
    error BadBps();
    error NonceAlreadyUsed(uint256 nonce);
    error VoucherExpired(uint256 deadline);
    error BadSigner(address recovered);
    error SeasonNotEnded(uint256 season);
    error PoolTokenMismatch();
    error NoPool();
    error RankEmpty(uint256 rank);
    error NotRanked(uint256 rank);
    error AlreadyClaimed(uint256 rank);
    error GraceNotElapsed();

    /// @param admin       receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE.
    /// @param sweepGrace_ seconds after season end before unclaimed prize sweep is allowed.
    constructor(address admin, uint256 sweepGrace_) EIP712("ArcadeLeaderboard", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        sweepGrace = sweepGrace_;
    }

    // --------------------------------------------------------------------- //
    //                              Admin config                             //
    // --------------------------------------------------------------------- //

    /// @notice Register a game. `rankBps` are payout weights by rank (index 0 = 1st); they must
    ///         sum to 10000 and have at most `topN` entries. Default top-3 split [5000,3000,2000].
    function registerGame(
        bytes32 gameId,
        uint8 topN,
        uint64 seasonLength,
        address attester,
        uint16[] calldata rankBps
    ) external onlyRole(ADMIN_ROLE) {
        if (_games[gameId].registered) revert AlreadyRegistered(gameId);
        if (topN == 0 || topN > MAX_TOP_N) revert BadTopN(topN);
        if (seasonLength == 0) revert BadSeasonLength();
        if (attester == address(0)) revert ZeroAddress();
        _validateBps(rankBps, topN);

        Game storage g = _games[gameId];
        g.registered = true;
        g.topN = topN;
        g.seasonLength = seasonLength;
        g.attester = attester;
        g.rankBps = rankBps;
        emit GameRegistered(gameId, topN, seasonLength, attester);
    }

    function setAttester(bytes32 gameId, address attester) external onlyRole(ADMIN_ROLE) {
        if (!_games[gameId].registered) revert NotRegistered(gameId);
        if (attester == address(0)) revert ZeroAddress();
        _games[gameId].attester = attester;
        emit AttesterUpdated(gameId, attester);
    }

    function setRankBps(bytes32 gameId, uint16[] calldata rankBps) external onlyRole(ADMIN_ROLE) {
        Game storage g = _games[gameId];
        if (!g.registered) revert NotRegistered(gameId);
        _validateBps(rankBps, g.topN);
        g.rankBps = rankBps;
        emit RankBpsUpdated(gameId, rankBps);
    }

    function setSweepGrace(uint256 sweepGrace_) external onlyRole(ADMIN_ROLE) {
        sweepGrace = sweepGrace_;
        emit SweepGraceUpdated(sweepGrace_);
    }

    // --------------------------------------------------------------------- //
    //                                Views                                  //
    // --------------------------------------------------------------------- //

    function currentSeason(bytes32 gameId) public view returns (uint256) {
        Game storage g = _games[gameId];
        if (!g.registered) revert NotRegistered(gameId);
        return block.timestamp / g.seasonLength;
    }

    function getGame(bytes32 gameId)
        external
        view
        returns (uint8 topN, uint64 seasonLength, address attester, uint16[] memory rankBps)
    {
        Game storage g = _games[gameId];
        if (!g.registered) revert NotRegistered(gameId);
        return (g.topN, g.seasonLength, g.attester, g.rankBps);
    }

    function getBoard(bytes32 gameId, uint256 season) external view returns (Entry[] memory) {
        return _board[gameId][season];
    }

    function getPool(bytes32 gameId, uint256 season)
        external
        view
        returns (address token, uint256 total, bool finalized)
    {
        Pool storage p = _pools[gameId][season];
        return (address(p.token), p.total, p.finalized);
    }

    /// @notice EIP-712 digest a score voucher signature must cover.
    function hashScore(
        address player,
        bytes32 gameId,
        uint256 season,
        uint256 score,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SCORE_TYPEHASH, player, gameId, season, score, nonce, deadline))
        );
    }

    // --------------------------------------------------------------------- //
    //                              Post score                               //
    // --------------------------------------------------------------------- //

    /// @notice Submit an attester-signed score voucher and insert it into the top-N board.
    function postScore(
        address player,
        bytes32 gameId,
        uint256 season,
        uint256 score,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Game storage g = _games[gameId];
        if (!g.registered) revert NotRegistered(gameId);
        if (player == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert VoucherExpired(deadline);
        if (usedNonce[gameId][nonce]) revert NonceAlreadyUsed(nonce);

        bytes32 digest = hashScore(player, gameId, season, score, nonce, deadline);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != g.attester) revert BadSigner(recovered);

        usedNonce[gameId][nonce] = true;
        uint256 rank = _insert(_board[gameId][season], g.topN, player, score);
        emit ScorePosted(gameId, season, player, score, rank);
    }

    /// @dev Insert (player, score) into a sorted-descending fixed-cap board. Returns the 0-based
    ///      rank it landed at, or `cap` if it did not make the board. O(cap) shift.
    function _insert(Entry[] storage board, uint8 cap, address player, uint256 score)
        private
        returns (uint256)
    {
        uint256 len = board.length;
        // Find insertion index (first entry with a strictly smaller score).
        uint256 pos = len;
        for (uint256 i = 0; i < len; i++) {
            if (score > board[i].score) {
                pos = i;
                break;
            }
        }
        if (pos >= cap) return cap; // below the cutoff and board already full
        if (len < cap) {
            board.push(Entry(address(0), 0)); // grow by one; tail filled by the shift
            len += 1;
        }
        // Shift entries [pos, len-1) down by one, dropping the last.
        for (uint256 j = len - 1; j > pos; j--) {
            board[j] = board[j - 1];
        }
        board[pos] = Entry(player, score);
        return pos;
    }

    // --------------------------------------------------------------------- //
    //                              Prize pools                              //
    // --------------------------------------------------------------------- //

    /// @notice Fund a (gameId, season) prize pool with an ERC-20. All funders of a pool must use
    ///         the same token. Future or current seasons may be funded.
    function fundPool(bytes32 gameId, uint256 season, IERC20 token, uint256 amount) external {
        if (!_games[gameId].registered) revert NotRegistered(gameId);
        if (address(token) == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Pool storage p = _pools[gameId][season];
        if (address(p.token) == address(0)) {
            p.token = token;
        } else if (address(p.token) != address(token)) {
            revert PoolTokenMismatch();
        }
        p.total += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(gameId, season, msg.sender, amount);
    }

    /// @notice After a season ends, the player at `rank` (0-based) on that board pulls their
    ///         prize share. Pull-based and single-use per rank.
    function claimPrize(bytes32 gameId, uint256 season, uint256 rank) external {
        Game storage g = _games[gameId];
        if (!g.registered) revert NotRegistered(gameId);
        if (season >= block.timestamp / g.seasonLength) revert SeasonNotEnded(season);

        Pool storage p = _pools[gameId][season];
        if (p.total == 0) revert NoPool();
        if (rankClaimed[gameId][season][rank]) revert AlreadyClaimed(rank);
        if (rank >= g.rankBps.length) revert NotRanked(rank);

        Entry[] storage board = _board[gameId][season];
        if (rank >= board.length) revert RankEmpty(rank);
        address player = board[rank].player;

        uint256 amount = (p.total * g.rankBps[rank]) / BPS_DENOM;
        rankClaimed[gameId][season][rank] = true;
        p.finalized = true;
        if (amount != 0) p.token.safeTransfer(player, amount);
        emit PrizeClaimed(gameId, season, rank, player, amount);
    }

    /// @notice After season end + grace, admin sweeps the remaining (unclaimed) pool balance.
    function sweepPool(bytes32 gameId, uint256 season, address to) external onlyRole(ADMIN_ROLE) {
        Game storage g = _games[gameId];
        if (!g.registered) revert NotRegistered(gameId);
        if (to == address(0)) revert ZeroAddress();
        // Season must have ended AND the grace window elapsed.
        if (block.timestamp < (season + 1) * g.seasonLength + sweepGrace) revert GraceNotElapsed();

        Pool storage p = _pools[gameId][season];
        if (p.total == 0) revert NoPool();
        IERC20 token = p.token;
        uint256 amount = token.balanceOf(address(this));
        // Guard against draining other pools sharing this token: cap at this pool's total.
        if (amount > p.total) amount = p.total;
        if (amount == 0) revert ZeroAmount();
        p.total = 0;
        p.finalized = true;
        token.safeTransfer(to, amount);
        emit PoolSwept(gameId, season, to, amount);
    }

    // --------------------------------------------------------------------- //
    //                               Helpers                                 //
    // --------------------------------------------------------------------- //

    /// @dev rankBps must be non-empty, ≤ topN entries, and sum to exactly 10000.
    function _validateBps(uint16[] calldata rankBps, uint8 topN) private pure {
        if (rankBps.length == 0 || rankBps.length > topN) revert BadBps();
        uint256 sum;
        for (uint256 i = 0; i < rankBps.length; i++) {
            sum += rankBps[i];
        }
        if (sum != BPS_DENOM) revert BadBps();
    }
}
