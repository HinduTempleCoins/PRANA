// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title LastEmberRules — misère Nim ("last to take loses") for the GameTable engine.
/// @notice Two players alternate removing 1..3 objects from a single chosen non-empty heap.
///         The player forced to take the very LAST object across all heaps LOSES (misère
///         play). Turn-based; GameTable owns rotation and settlement, this contract is
///         stateless.
/// @dev CONFIG ENCODING (passed to {initialState}): the raw heap sizes as bytes, one byte
///        per heap, 1..8 heaps, each size 1..255. e.g. bytes hex"030405" = heaps [3,4,5].
///      STATE ENCODING (opaque to GameTable): a length-prefix-free byte string where
///        state[0]            = lastMover, the 1-based player index who took the previous
///                              object (0 = no move yet at game start), and
///        state[1 .. n]       = the current size of each heap (n = heap count).
///      Storing lastMover lets {status} name the loser once every heap is empty: the player
///      who removed the last object loses, so the OTHER player (1-based) is the winner.
///      MOVE ENCODING: 2 bytes = (heapIndex, take):
///        move[0] = heap index (0-based) to draw from,
///        move[1] = how many to remove, in 1..3 (and not exceeding that heap's size).
contract LastEmberRules is IGameRules {
    uint8 internal constant MAX_HEAPS = 8;
    uint8 internal constant MAX_TAKE = 3;

    error BadConfig();
    error BadPlayerCount();
    error BadStateLength();
    error BadMoveLength();
    error HeapOutOfRange();
    error BadTakeAmount();
    error HeapTooSmall();
    error GameOver();

    /// @inheritdoc IGameRules
    /// @dev `config` is the heap sizes (one byte each, 1..8 heaps, each non-zero). The
    ///      built state prepends a `lastMover = 0` byte (no move yet).
    function initialState(bytes calldata config, uint8 numPlayers)
        external
        pure
        returns (bytes memory state)
    {
        if (numPlayers != 2) revert BadPlayerCount();
        uint256 n = config.length;
        if (n == 0 || n > MAX_HEAPS) revert BadConfig();

        state = new bytes(n + 1);
        state[0] = bytes1(uint8(0)); // lastMover: nobody has moved yet
        for (uint256 i = 0; i < n; i++) {
            if (uint8(config[i]) == 0) revert BadConfig(); // empty heaps disallowed
            state[i + 1] = config[i];
        }
    }

    /// @inheritdoc IGameRules
    /// @dev Removes `take` objects from heap `heapIndex` and records the mover. Reverts on
    ///      any illegal draw. GameTable has already enforced it is `playerIndex`'s turn.
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory newState)
    {
        if (state.length < 2) revert BadStateLength();
        if (move.length != 2) revert BadMoveLength();
        if (playerIndex > 1) revert BadPlayerCount();
        if (_allEmpty(state)) revert GameOver();

        uint8 heapIndex = uint8(move[0]);
        uint8 take = uint8(move[1]);
        uint256 heapCount = state.length - 1;
        if (heapIndex >= heapCount) revert HeapOutOfRange();
        if (take == 0 || take > MAX_TAKE) revert BadTakeAmount();

        uint8 size = uint8(state[heapIndex + 1]);
        if (take > size) revert HeapTooSmall();

        newState = state; // copy
        newState[heapIndex + 1] = bytes1(size - take);
        newState[0] = bytes1(playerIndex + 1); // record who just took (1-based)
    }

    /// @inheritdoc IGameRules
    /// @dev Ongoing while any heap has objects. Once all heaps are empty the last mover
    ///      lost (misère), so the winner is the other player.
    function status(bytes calldata state) external pure returns (uint8 s) {
        if (state.length < 2) revert BadStateLength();
        if (!_allEmpty(state)) return 0; // ongoing

        uint8 lastMover = uint8(state[0]); // 1 or 2 (cannot be 0 once a heap was emptied)
        // The mover who took the final object loses; the other player wins.
        return lastMover == 1 ? 2 : 1;
    }

    /// @inheritdoc IGameRules
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false; // strictly turn-based
    }

    function gameName() external pure returns (string memory) {
        return "LastEmber";
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

    /// @dev True when every heap (bytes 1..end) is empty.
    function _allEmpty(bytes calldata state) internal pure returns (bool) {
        for (uint256 i = 1; i < state.length; i++) {
            if (uint8(state[i]) != 0) return false;
        }
        return true;
    }
}
