// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title TriadRules — tic-tac-toe (3×3) rules for the GameTable engine.
/// @notice A turn-based, two-player board game. GameTable owns turn rotation, stakes and
///         settlement; this contract owns ONLY the board logic and is fully stateless.
/// @dev STATE ENCODING (9 bytes, opaque to GameTable):
///        state[i] = cell i, row-major (i = row*3 + col, i in 0..8).
///        cell value: 0 = empty, 1 = player-1's mark, 2 = player-2's mark.
///      There is no separate "whose turn" byte — GameTable enforces strict rotation, and
///      a move's mark is derived as `playerIndex + 1`. We additionally validate that the
///      mark counts are consistent with it being this player's turn (p1 always has the same
///      number of marks as p2, or exactly one more), as a defence-in-depth check.
///      MOVE ENCODING: 1 byte = the cell index 0..8 to place the caller's mark in.
contract TriadRules is IGameRules {
    error BadPlayerCount();
    error BadStateLength();
    error BadMoveLength();
    error CellOutOfRange();
    error CellTaken();
    error GameOver();
    error NotYourTurn();

    /// @inheritdoc IGameRules
    /// @dev config is ignored (the board is always 3×3). numPlayers must be 2.
    function initialState(bytes calldata, uint8 numPlayers)
        external
        pure
        returns (bytes memory state)
    {
        if (numPlayers != 2) revert BadPlayerCount();
        state = new bytes(9); // all cells 0 (empty)
    }

    /// @inheritdoc IGameRules
    /// @dev Places `playerIndex + 1` into the target empty cell. Reverts on any illegality.
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory newState)
    {
        if (state.length != 9) revert BadStateLength();
        if (move.length != 1) revert BadMoveLength();
        if (playerIndex > 1) revert BadPlayerCount();
        if (_status(state) != 0) revert GameOver();

        uint8 cell = uint8(move[0]);
        if (cell > 8) revert CellOutOfRange();
        if (uint8(state[cell]) != 0) revert CellTaken();

        uint8 mark = playerIndex + 1; // 1 or 2

        // Defence-in-depth: confirm the marker counts are consistent with this being
        // `playerIndex`'s turn. p1 moves on even total-mark counts, p2 on odd.
        {
            (uint8 c1, uint8 c2) = _counts(state);
            uint8 expectedMover = (c1 == c2) ? 1 : 2; // p1 when balanced, else p2
            if (expectedMover != mark) revert NotYourTurn();
        }

        newState = state; // copy
        newState[cell] = bytes1(mark);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        if (state.length != 9) revert BadStateLength();
        return _status(state);
    }

    /// @inheritdoc IGameRules
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false; // strictly turn-based
    }

    function gameName() external pure returns (string memory) {
        return "Triad";
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

    /// @dev 0 = ongoing · 1 = p1 won · 2 = p2 won · 255 = draw (full board, no line).
    function _status(bytes calldata state) internal pure returns (uint8) {
        uint8 w = _winner(state);
        if (w != 0) return w;

        // No winner: a full board is a draw, otherwise the game is still ongoing.
        for (uint256 i = 0; i < 9; i++) {
            if (uint8(state[i]) == 0) return 0; // empty cell remains → ongoing
        }
        return 255; // draw
    }

    /// @dev Returns the winning mark (1 or 2) or 0 if no completed line exists.
    function _winner(bytes calldata state) internal pure returns (uint8) {
        // 8 winning lines: 3 rows, 3 cols, 2 diagonals.
        uint8[3][8] memory lines = [
            [uint8(0), 1, 2],
            [uint8(3), 4, 5],
            [uint8(6), 7, 8],
            [uint8(0), 3, 6],
            [uint8(1), 4, 7],
            [uint8(2), 5, 8],
            [uint8(0), 4, 8],
            [uint8(2), 4, 6]
        ];
        for (uint256 l = 0; l < 8; l++) {
            uint8 a = uint8(state[lines[l][0]]);
            if (a == 0) continue;
            if (a == uint8(state[lines[l][1]]) && a == uint8(state[lines[l][2]])) {
                return a;
            }
        }
        return 0;
    }

    /// @dev Counts of marks belonging to player 1 and player 2.
    function _counts(bytes calldata state) internal pure returns (uint8 c1, uint8 c2) {
        for (uint256 i = 0; i < 9; i++) {
            uint8 v = uint8(state[i]);
            if (v == 1) c1++;
            else if (v == 2) c2++;
        }
    }
}
