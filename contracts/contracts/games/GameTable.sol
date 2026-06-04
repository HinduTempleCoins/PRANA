// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IGameRules} from "./IGameRules.sol";

/// @title GameTable — the shared, staked, turn-based match engine for PRANA board games.
/// @notice One engine hosts every game: matchmaking (lobby/join), stake escrow (native or
///         ERC-20), turn rotation (or simultaneous-round phases), per-move deadlines with
///         timeout-forfeit, draw offers, cancellation refunds, and pot settlement with an
///         admin-set rake. All game-specific logic is delegated to a pluggable
///         {IGameRules} contract; this engine never interprets the opaque state/move bytes.
/// @dev Money paths are guarded with {ReentrancyGuard}. The rake is capped at 5% (500 bps)
///      and routed to a per-match `rakeRecipient` (FeeRouter-compatible — a plain address
///      that may itself be a router/splitter).
contract GameTable is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Hard cap on the rake, in basis points (5%).
    uint16 public constant MAX_RAKE_BPS = 500;
    uint16 public constant BPS_DENOMINATOR = 10000;

    enum Status {
        Open, // lobby filling, not started
        Active, // started, in play
        Settled, // finished and paid out
        Cancelled // cancelled before start, stakes refunded
    }

    /// @dev Compact per-match record. `state` (opaque game bytes) is stored separately to
    ///      keep this struct tight. Player addresses live in `_players[id]`.
    struct Match {
        IGameRules rules; // game logic contract
        address stakeToken; // address(0) = native, else ERC-20
        uint96 stakeAmount; // per-player stake
        address rakeRecipient; // where the rake is routed on settlement
        uint64 moveTimeout; // seconds allowed per move (0 = no timeout)
        uint64 moveDeadline; // timestamp the current mover must act by
        uint16 rakeBps; // rake snapshotted at creation
        uint8 minPlayers; // min to start
        uint8 maxPlayers; // capacity (auto-starts when full)
        uint8 numPlayers; // joined so far
        uint8 turnIndex; // whose turn (index into players) for rotation phases
        uint8 actedMask; // bitmap of players who acted this simultaneous round
        uint16 startedRound; // current simultaneous round (1-based; 0 before start)
        Status status;
        uint8 winner; // settlement outcome: 1-based winner, 255 draw, 0 unsettled
    }

    uint256 public nextMatchId;

    mapping(uint256 => Match) private _matches;
    mapping(uint256 => address[]) private _players;
    mapping(uint256 => bytes) private _state;
    /// @dev id => player => joined?  (membership lookup without scanning the array).
    mapping(uint256 => mapping(address => bool)) public isPlayer;
    /// @dev id => player => has an open draw offer standing.
    mapping(uint256 => mapping(address => bool)) public drawOffer;

    /// @notice Default rake applied to newly created matches (admin-set, ≤ MAX_RAKE_BPS).
    uint16 public defaultRakeBps;
    /// @notice Default rake recipient for newly created matches (admin-set).
    address public defaultRakeRecipient;

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

    error ZeroRules();
    error BadPlayerBounds();
    error RakeTooHigh();
    error ZeroRakeRecipient();
    error WrongNativeValue();
    error NativeNotAccepted();
    error NotOpen();
    error NotActive();
    error AlreadyJoined();
    error MatchFull();
    error NotCreator();
    error NotEnoughPlayers();
    error NotAMember();
    error NotYourTurn();
    error AlreadyActedThisRound();
    error SimultaneousPhase();
    error NoTimeout();
    error DeadlineNotPassed();
    error NoDrawOffer();

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    /// @param rakeBps_ Initial default rake (≤ MAX_RAKE_BPS).
    /// @param rakeRecipient_ Initial default rake recipient (non-zero).
    constructor(address admin, uint16 rakeBps_, address rakeRecipient_) {
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();
        if (rakeRecipient_ == address(0)) revert ZeroRakeRecipient();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        defaultRakeBps = rakeBps_;
        defaultRakeRecipient = rakeRecipient_;
    }

    // --------------------------------------------------------------------- //
    //  Admin                                                                //
    // --------------------------------------------------------------------- //

    /// @notice Update the default rake (bps, ≤ cap) and its recipient for FUTURE matches.
    ///         Existing matches keep the rake snapshotted at their creation.
    function setDefaultRake(uint16 rakeBps_, address rakeRecipient_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();
        if (rakeRecipient_ == address(0)) revert ZeroRakeRecipient();
        defaultRakeBps = rakeBps_;
        defaultRakeRecipient = rakeRecipient_;
        emit DefaultRakeUpdated(rakeBps_, rakeRecipient_);
    }

    // --------------------------------------------------------------------- //
    //  Lobby                                                                //
    // --------------------------------------------------------------------- //

    /// @notice Open a new match lobby and auto-join the creator (escrowing their stake).
    /// @param rules The game logic contract.
    /// @param config Game setup bytes forwarded to {IGameRules-initialState} at start.
    /// @param stakeToken address(0) for native PRANA (send via msg.value), else an ERC-20.
    /// @param stakeAmount Per-player stake.
    /// @param maxPlayers_ Capacity; 0 means "use the rules' maxPlayers". Clamped to rules.
    /// @param moveTimeout Seconds allowed per move (0 = no deadline / no timeout-forfeit).
    /// @return id The new match id.
    function createMatch(
        IGameRules rules,
        bytes calldata config,
        address stakeToken,
        uint96 stakeAmount,
        uint8 maxPlayers_,
        uint64 moveTimeout
    ) external payable nonReentrant returns (uint256 id) {
        if (address(rules) == address(0)) revert ZeroRules();

        id = nextMatchId++;
        _initMatch(id, rules, stakeToken, stakeAmount, maxPlayers_, moveTimeout, config);

        // Creator escrows their stake and is recorded as player 0.
        _pullStake(stakeToken, stakeAmount);
        _enroll(id, msg.sender);

        emit MatchCreated(
            id, msg.sender, address(rules), stakeToken, stakeAmount,
            _matches[id].minPlayers, _matches[id].maxPlayers
        );
        emit PlayerJoined(id, msg.sender, 1);
    }

    /// @dev Validates bounds and writes the immutable parts of a new Match. Stores config
    ///      temporarily in `_state` (overwritten by initialState at start).
    function _initMatch(
        uint256 id,
        IGameRules rules,
        address stakeToken,
        uint96 stakeAmount,
        uint8 maxPlayers_,
        uint64 moveTimeout,
        bytes calldata config
    ) internal {
        uint8 rMin = rules.minPlayers();
        uint8 rMax = rules.maxPlayers();
        uint8 cap = maxPlayers_ == 0 ? rMax : maxPlayers_;
        if (rMin == 0 || rMax < rMin || cap < rMin || cap > rMax) revert BadPlayerBounds();

        Match storage m = _matches[id];
        m.rules = rules;
        m.stakeToken = stakeToken;
        m.stakeAmount = stakeAmount;
        m.moveTimeout = moveTimeout;
        m.rakeBps = defaultRakeBps;
        m.rakeRecipient = defaultRakeRecipient;
        m.minPlayers = rMin;
        m.maxPlayers = cap;
        m.status = Status.Open;
        _state[id] = config; // stashed until start
    }

    /// @notice Join an open lobby, escrowing the per-player stake. Auto-starts when full.
    function joinMatch(uint256 id) external payable nonReentrant {
        Match storage m = _matches[id];
        if (m.status != Status.Open) revert NotOpen();
        if (isPlayer[id][msg.sender]) revert AlreadyJoined();
        if (m.numPlayers >= m.maxPlayers) revert MatchFull();

        _pullStake(m.stakeToken, m.stakeAmount);
        _enroll(id, msg.sender);
        emit PlayerJoined(id, msg.sender, m.numPlayers);

        // Auto-start once the lobby is full.
        if (m.numPlayers == m.maxPlayers) _start(id);
    }

    /// @notice Creator may start a match early once minPlayers have joined.
    function startMatch(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Open) revert NotOpen();
        if (_players[id][0] != msg.sender) revert NotCreator();
        if (m.numPlayers < m.minPlayers) revert NotEnoughPlayers();
        _start(id);
    }

    /// @notice Cancel an unstarted match; refunds every joined player's stake.
    /// @dev Only the creator may cancel, and only while still Open.
    function cancelMatch(uint256 id) external nonReentrant {
        Match storage m = _matches[id];
        if (m.status != Status.Open) revert NotOpen();
        if (_players[id][0] != msg.sender) revert NotCreator();

        m.status = Status.Cancelled;

        address token = m.stakeToken;
        uint256 amount = m.stakeAmount;
        address[] storage ps = _players[id];
        for (uint256 i = 0; i < ps.length; i++) {
            _payout(token, ps[i], amount);
        }
        emit MatchCancelled(id);
    }

    // --------------------------------------------------------------------- //
    //  Play                                                                 //
    // --------------------------------------------------------------------- //

    /// @notice Submit a move. Enforces membership and turn/round rules, applies it through
    ///         the rules contract, stores the new state, and settles if terminal.
    function submitMove(uint256 id, bytes calldata move) external nonReentrant {
        Match storage m = _matches[id];
        if (m.status != Status.Active) revert NotActive();
        if (!isPlayer[id][msg.sender]) revert NotAMember();

        uint8 idx = _indexOf(id, msg.sender);
        bool simul = m.rules.simultaneous(_state[id]);
        _enforceTurn(m, simul, idx);

        // Apply via the (stateless) rules contract and persist the result.
        _state[id] = m.rules.applyMove(_state[id], idx, move);
        emit MoveMade(id, msg.sender, move);

        _advance(id, m, simul, idx);

        // Settle on a terminal status, else (re)arm the per-move deadline.
        uint8 s = m.rules.status(_state[id]);
        if (s != 0) {
            _settle(id, s);
        } else {
            _armDeadline(m);
        }
    }

    /// @dev Reverts unless it is `idx`'s legal time to act for the current phase.
    function _enforceTurn(Match storage m, bool simul, uint8 idx) internal view {
        if (simul) {
            if (_acted(m.actedMask, idx)) revert AlreadyActedThisRound();
        } else {
            if (m.turnIndex != idx) revert NotYourTurn();
        }
    }

    /// @dev Advance turn pointer (rotation) or acted-mask/round (simultaneous).
    function _advance(uint256 id, Match storage m, bool simul, uint8 idx) internal {
        if (!simul) {
            m.turnIndex = uint8((m.turnIndex + 1) % m.numPlayers);
            return;
        }
        m.actedMask = uint8(m.actedMask | uint8(1 << idx));
        // Round completes once every player has acted; reset the mask for the next round.
        uint8 full = uint8((1 << m.numPlayers) - 1);
        if (m.actedMask == full) {
            m.actedMask = 0;
            m.startedRound += 1;
            emit RoundAdvanced(id, m.startedRound);
        }
    }

    // --------------------------------------------------------------------- //
    //  Timeout / draw                                                       //
    // --------------------------------------------------------------------- //

    /// @notice Anyone may call once the current mover blew the per-move deadline: the
    ///         stalled player forfeits and the match settles in favour of the others.
    /// @dev Only meaningful for rotation phases (a single identifiable stalled mover). For
    ///      simultaneous phases there is no single "current mover", so timeout-forfeit is
    ///      not offered there.
    function claimTimeout(uint256 id) external nonReentrant {
        Match storage m = _matches[id];
        if (m.status != Status.Active) revert NotActive();
        if (m.moveTimeout == 0) revert NoTimeout();
        if (m.rules.simultaneous(_state[id])) revert SimultaneousPhase();
        if (block.timestamp <= m.moveDeadline) revert DeadlineNotPassed();

        address stalled = _players[id][m.turnIndex];
        // Two-player games: the other player wins. (minPlayers/maxPlayers == 2 for the
        // shipped rules.) For >2-player rotation games the stalled player is removed from
        // contention by handing the win to the next player in rotation.
        uint8 winnerIdx = uint8((m.turnIndex + 1) % m.numPlayers);
        emit TimeoutClaimed(id, stalled, msg.sender);
        _settle(id, winnerIdx + 1); // 1-based winner
    }

    /// @notice Offer a draw. Once every other still-standing player has an open offer, any
    ///         of them may {acceptDraw} to end the match as a draw (stakes returned).
    function offerDraw(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Active) revert NotActive();
        if (!isPlayer[id][msg.sender]) revert NotAMember();
        drawOffer[id][msg.sender] = true;
        emit DrawOffered(id, msg.sender);
    }

    /// @notice Accept a pending draw. Requires that EVERY player (including the caller) has
    ///         an open draw offer, then settles as a draw.
    function acceptDraw(uint256 id) external nonReentrant {
        Match storage m = _matches[id];
        if (m.status != Status.Active) revert NotActive();
        if (!isPlayer[id][msg.sender]) revert NotAMember();

        drawOffer[id][msg.sender] = true; // accepting implies offering
        address[] storage ps = _players[id];
        for (uint256 i = 0; i < ps.length; i++) {
            if (!drawOffer[id][ps[i]]) revert NoDrawOffer();
        }
        emit DrawAccepted(id, msg.sender);
        _settle(id, 255); // draw
    }

    // --------------------------------------------------------------------- //
    //  Settlement / money                                                   //
    // --------------------------------------------------------------------- //

    /// @dev Mark started: build initial state from the stashed config via the rules
    ///      contract, arm the first deadline, and record the player count seen by the rules.
    function _start(uint256 id) internal {
        Match storage m = _matches[id];
        m.status = Status.Active;
        m.startedRound = 1;
        // `_state[id]` currently holds the stashed config; replace it with the live state.
        _state[id] = m.rules.initialState(_state[id], m.numPlayers);
        _armDeadline(m);
        emit MatchStarted(id, m.numPlayers);
    }

    /// @dev Resolve outcome `s` (1..n winner · 255 draw) and pay out the pot.
    ///      winner: pot minus rake to the winner, rake to the recipient.
    ///      draw:   each player gets their own stake back (no rake).
    function _settle(uint256 id, uint8 s) internal {
        Match storage m = _matches[id];
        m.status = Status.Settled;
        m.winner = s;

        address token = m.stakeToken;
        uint256 stake = m.stakeAmount;
        address[] storage ps = _players[id];

        if (s == 255) {
            // Draw: refund every stake, no rake.
            for (uint256 i = 0; i < ps.length; i++) {
                _payout(token, ps[i], stake);
            }
            emit MatchSettled(id, s, 0, 0);
            return;
        }

        uint256 pot = stake * ps.length;
        uint256 rake = (pot * m.rakeBps) / BPS_DENOMINATOR;
        uint256 prize = pot - rake;
        address winner = ps[s - 1]; // s is 1-based

        if (rake > 0) _payout(token, m.rakeRecipient, rake);
        _payout(token, winner, prize);
        emit MatchSettled(id, s, prize, rake);
    }

    /// @dev Pull `amount` of `token` (native via msg.value, else ERC-20) from msg.sender.
    function _pullStake(address token, uint256 amount) internal {
        if (token == address(0)) {
            if (msg.value != amount) revert WrongNativeValue();
        } else {
            if (msg.value != 0) revert NativeNotAccepted();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    /// @dev Send `amount` of `token` to `to` (native or ERC-20). No-op on zero.
    function _payout(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Record `player` as the next-indexed participant of match `id`.
    function _enroll(uint256 id, address player) internal {
        _players[id].push(player);
        isPlayer[id][player] = true;
        _matches[id].numPlayers += 1;
    }

    /// @dev (Re)arm the per-move deadline if a timeout is configured.
    function _armDeadline(Match storage m) internal {
        if (m.moveTimeout != 0) {
            m.moveDeadline = uint64(block.timestamp) + m.moveTimeout;
        }
    }

    // --------------------------------------------------------------------- //
    //  Bitmap / lookup helpers                                              //
    // --------------------------------------------------------------------- //

    function _acted(uint8 mask, uint8 idx) internal pure returns (bool) {
        return (mask & uint8(1 << idx)) != 0;
    }

    /// @dev Index of `player` within match `id`. Caller ensures membership.
    function _indexOf(uint256 id, address player) internal view returns (uint8) {
        address[] storage ps = _players[id];
        for (uint256 i = 0; i < ps.length; i++) {
            if (ps[i] == player) return uint8(i);
        }
        revert NotAMember();
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                //
    // --------------------------------------------------------------------- //

    function getMatch(uint256 id) external view returns (Match memory) {
        return _matches[id];
    }

    function getState(uint256 id) external view returns (bytes memory) {
        return _state[id];
    }

    function getPlayers(uint256 id) external view returns (address[] memory) {
        return _players[id];
    }

    function currentTurn(uint256 id) external view returns (address) {
        Match storage m = _matches[id];
        if (m.status != Status.Active) return address(0);
        return _players[id][m.turnIndex];
    }
}
