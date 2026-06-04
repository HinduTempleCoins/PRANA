// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title SeedSowerRules — two-rank mancala (Kalah) rules for the GameTable engine.
/// @notice Two players, each owning a rank of 6 pits and 1 store. Pits start with 4 seeds.
///         A turn picks one of your non-empty pits and sows its seeds one-per-hole going
///         counter-clockwise, skipping the OPPONENT'S store. If the last seed lands in your
///         own store you earn another turn; if it lands in one of your own previously-EMPTY
///         pits you capture that seed plus all seeds in the directly opposite pit into your
///         store. When one player's six pits are all empty the game ends and the other player
///         banks their remaining pit-seeds into their store; higher store wins, equal = draw.
///
/// @dev EXTRA-TURN HANDLING (the GameTable rotation collision): GameTable enforces strict
///      turn alternation, but a Kalah turn can chain (landing in your store grants another
///      sow). We encode the whole chain into ONE move: a `move` is an ARRAY of pit choices
///      (the streak), validated and applied atomically inside {applyMove}. Each element after
///      the first is ONLY legal if the IMMEDIATELY PRECEDING sow ended in the mover's own
///      store (i.e. earned the extra turn). The final element MUST NOT end in the store
///      (a turn that ends in your store would have to continue) UNLESS the board reached a
///      terminal position. Thus the player submits their full streak as a single transaction.
///
/// @dev BOARD INDEXING (counter-clockwise, 14 slots):
///        slots 0..5   = player 1's pits (sowing direction increasing)
///        slot  6      = player 1's store
///        slots 7..12  = player 2's pits (sowing direction increasing)
///        slot  13     = player 2's store
///      Counter-clockwise sowing steps index+1 (mod 14), skipping the opponent store.
///      "Opposite pit" of pit i is pit (12 - i) — pairs (0,12)(1,11)(2,10)(3,9)(4,8)(5,7).
///
/// @dev STATE ENCODING (abi.encode, stateless — all match state lives in GameTable):
///        (uint8[14] board, uint8 toMove, bool over)
///      - board: seed counts per slot, layout above.
///      - toMove: 1-based player whose turn it is (1 or 2). Drives store/pit ownership.
///      - over: true once a side's pits emptied and the sweep was banked (terminal).
///
/// @dev MOVE ENCODING: abi.encode(uint8[] pits) — the streak of pit choices. Each pit is the
///      player-LOCAL index 0..5 (mapped to absolute slots by the mover's ownership).
contract SeedSowerRules is IGameRules {
    uint8 internal constant PITS = 6;
    uint8 internal constant SLOTS = 14;
    uint8 internal constant P1_STORE = 6;
    uint8 internal constant P2_STORE = 13;
    uint8 internal constant START_SEEDS = 4;

    error BadPlayerCount();
    error BadPlayer();
    error GameOver();
    error EmptyMove();
    error PitOutOfRange();
    error PitEmpty();
    error NoExtraTurn();
    error MustContinue();

    /// @inheritdoc IGameRules
    function initialState(bytes calldata, uint8 numPlayers)
        external
        pure
        returns (bytes memory)
    {
        if (numPlayers != 2) revert BadPlayerCount();
        uint8[SLOTS] memory board;
        for (uint8 i = 0; i < SLOTS; ++i) {
            board[i] = (i == P1_STORE || i == P2_STORE) ? 0 : START_SEEDS;
        }
        return abi.encode(board, uint8(1), false);
    }

    /// @inheritdoc IGameRules
    /// @dev Applies the full streak atomically; reverts on any illegal continuation.
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        if (playerIndex > 1) revert BadPlayer();
        (uint8[SLOTS] memory board, uint8 toMove, bool over) =
            abi.decode(state, (uint8[14], uint8, bool));
        if (over) revert GameOver();
        if (playerIndex + 1 != toMove) revert BadPlayer();

        uint8[] memory pits = abi.decode(move, (uint8[]));
        if (pits.length == 0) revert EmptyMove();

        bool extra = _runStreak(board, toMove, pits);

        // Endgame: if either side's pits are all empty, sweep & finish.
        if (_sideEmpty(board, 1) || _sideEmpty(board, 2)) {
            _sweep(board);
            return abi.encode(board, toMove, true);
        }
        // Not terminal: the final sow must NOT have earned another turn (that would have to
        // continue inside this same move). A legal streak ends by passing the turn.
        if (extra) revert MustContinue();

        uint8 next = toMove == 1 ? 2 : 1;
        return abi.encode(board, next, false);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        (uint8[SLOTS] memory board,, bool over) =
            abi.decode(state, (uint8[14], uint8, bool));
        if (!over) return 0;
        uint8 a = board[P1_STORE];
        uint8 b = board[P2_STORE];
        if (a > b) return 1;
        if (b > a) return 2;
        return 255; // draw
    }

    /// @inheritdoc IGameRules
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "SeedSower";
    }

    function minPlayers() external pure returns (uint8) {
        return 2;
    }

    function maxPlayers() external pure returns (uint8) {
        return 2;
    }

    // --------------------------------------------------------------------- //
    //  Internal logic                                                       //
    // --------------------------------------------------------------------- //

    /// @dev Run every pit choice in the streak. Returns whether the LAST sow earned an extra
    ///      turn. Each element after the first requires the previous sow to have earned one.
    function _runStreak(uint8[SLOTS] memory board, uint8 toMove, uint8[] memory pits)
        internal
        pure
        returns (bool extra)
    {
        extra = false;
        for (uint256 k = 0; k < pits.length; ++k) {
            if (k > 0 && !extra) revert NoExtraTurn();
            // Stop chaining once the board is terminal (sweep handled by caller).
            if (k > 0 && (_sideEmpty(board, 1) || _sideEmpty(board, 2))) revert NoExtraTurn();
            extra = _sow(board, toMove, pits[k]);
        }
    }

    /// @dev Sow one pit. Returns true when the last seed landed in the mover's own store.
    function _sow(uint8[SLOTS] memory board, uint8 toMove, uint8 localPit)
        internal
        pure
        returns (bool landedInStore)
    {
        if (localPit >= PITS) revert PitOutOfRange();
        uint8 start = _pitSlot(toMove, localPit);
        uint8 seeds = board[start];
        if (seeds == 0) revert PitEmpty();
        board[start] = 0;

        uint8 oppStore = toMove == 1 ? P2_STORE : P1_STORE;
        uint8 ownStore = toMove == 1 ? P1_STORE : P2_STORE;
        uint8 pos = start;
        while (seeds > 0) {
            pos = (pos + 1) % SLOTS;
            if (pos == oppStore) continue; // skip opponent's store
            board[pos] += 1;
            seeds -= 1;
        }

        if (pos == ownStore) return true;
        _maybeCapture(board, toMove, pos, ownStore);
        return false;
    }

    /// @dev Capture rule: if the last seed landed in one of the mover's OWN pits that was
    ///      empty before this seed (now holds exactly 1) and the opposite pit is non-empty,
    ///      move both that seed and the opposite pit's seeds into the mover's store.
    function _maybeCapture(
        uint8[SLOTS] memory board,
        uint8 toMove,
        uint8 landed,
        uint8 ownStore
    ) internal pure {
        if (!_ownsPit(toMove, landed)) return;
        if (board[landed] != 1) return;
        uint8 opposite = 12 - landed; // pairs across the board
        uint8 grabbed = board[opposite];
        if (grabbed == 0) return;
        board[opposite] = 0;
        board[landed] = 0;
        board[ownStore] += grabbed + 1;
    }

    /// @dev When the game ends, each player banks the seeds remaining in their own pits.
    function _sweep(uint8[SLOTS] memory board) internal pure {
        for (uint8 i = 0; i < PITS; ++i) {
            board[P1_STORE] += board[i];
            board[i] = 0;
            board[P2_STORE] += board[PITS + 1 + i];
            board[PITS + 1 + i] = 0;
        }
    }

    /// @dev Absolute slot of a player's local pit index (0..5).
    function _pitSlot(uint8 player, uint8 localPit) internal pure returns (uint8) {
        return player == 1 ? localPit : uint8(PITS + 1 + localPit);
    }

    /// @dev True if absolute `slot` is one of `player`'s six pits (not a store).
    function _ownsPit(uint8 player, uint8 slot) internal pure returns (bool) {
        return player == 1 ? slot < PITS : (slot >= PITS + 1 && slot < P2_STORE);
    }

    /// @dev True when all six of `player`'s pits are empty.
    function _sideEmpty(uint8[SLOTS] memory board, uint8 player) internal pure returns (bool) {
        uint8 base = player == 1 ? 0 : uint8(PITS + 1);
        for (uint8 i = 0; i < PITS; ++i) {
            if (board[base + i] != 0) return false;
        }
        return true;
    }
}
