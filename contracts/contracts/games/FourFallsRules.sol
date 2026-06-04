// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title FourFallsRules — connect-four (7 columns × 6 rows) rules for GameTable.
/// @notice Two players drop discs into 7 columns; gravity settles each disc to the lowest
///         empty cell of the chosen column. First to align 4 discs (horizontal, vertical, or
///         either diagonal) wins; a full board with no alignment is a draw.
///
/// @dev STATE ENCODING (abi.encode of 4 fields, stateless — all match state lives in GameTable):
///        (uint8[42] board, uint8 moveCount, int8 lastCell, uint8 lastPlayer)
///      - board: 42 cells, index = row*7 + col. row 0 is the BOTTOM row, col 0 is the LEFT
///        column. Cell value: 0 = empty, 1 = player-1 disc, 2 = player-2 disc.
///      - moveCount: number of discs placed (0..42); also drives whose turn it is.
///      - lastCell: board index of the most recently placed disc, or -1 when none. The win
///        scan only inspects the four line-directions THROUGH this cell (gas-lean).
///      - lastPlayer: 1-based player who placed lastCell, or 0 when none.
///
///      MOVE ENCODING: abi.encode(uint8 col) — the column (0..6) to drop into.
///
///      playerIndex is 0-based from GameTable; the on-board disc colour is playerIndex+1.
contract FourFallsRules is IGameRules {
    uint8 internal constant COLS = 7;
    uint8 internal constant ROWS = 6;
    uint8 internal constant CELLS = 42; // COLS*ROWS

    /// @inheritdoc IGameRules
    function initialState(bytes calldata, uint8 numPlayers)
        external
        pure
        returns (bytes memory)
    {
        require(numPlayers == 2, "FourFalls: 2 players");
        uint8[CELLS] memory board; // all zero
        return abi.encode(board, uint8(0), int8(-1), uint8(0));
    }

    /// @inheritdoc IGameRules
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        require(playerIndex < 2, "FourFalls: bad player");
        (uint8[CELLS] memory board, uint8 moveCount,,) =
            abi.decode(state, (uint8[42], uint8, int8, uint8));
        require(_winnerOf(board, int8(-1)) == 0 && moveCount < CELLS, "FourFalls: over");

        uint8 col = abi.decode(move, (uint8));
        require(col < COLS, "FourFalls: bad col");

        // Gravity: find lowest empty cell in the column.
        uint8 cell = _drop(board, col);
        uint8 disc = playerIndex + 1;
        board[cell] = disc;

        return abi.encode(board, moveCount + 1, int8(uint8(cell)), disc);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        (uint8[CELLS] memory board, uint8 moveCount, int8 lastCell,) =
            abi.decode(state, (uint8[42], uint8, int8, uint8));
        uint8 w = _winnerOf(board, lastCell);
        if (w != 0) return w;
        if (moveCount >= CELLS) return 255; // draw
        return 0; // ongoing
    }

    /// @inheritdoc IGameRules
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "FourFalls";
    }

    function minPlayers() external pure returns (uint8) {
        return 2;
    }

    function maxPlayers() external pure returns (uint8) {
        return 2;
    }

    // ----------------------------------------------------------------- internals

    /// @dev Lowest empty cell in `col`; reverts when the column is full.
    function _drop(uint8[CELLS] memory board, uint8 col) internal pure returns (uint8) {
        for (uint8 row = 0; row < ROWS; ++row) {
            uint8 idx = row * COLS + col;
            if (board[idx] == 0) return idx;
        }
        revert("FourFalls: col full");
    }

    /// @dev Winner (1 or 2) or 0. When `lastCell >= 0` only the four lines through that cell
    ///      are scanned (gas-lean post-move check). When `lastCell < 0` a full board scan runs
    ///      (used by applyMove's "is the match already over?" guard and by safety).
    function _winnerOf(uint8[CELLS] memory board, int8 lastCell)
        internal
        pure
        returns (uint8)
    {
        if (lastCell >= 0) {
            return _scanThrough(board, uint8(lastCell));
        }
        // Full scan: treat every occupied cell as a line origin (only +directions checked
        // inside _scanThrough's run-length logic, so a full pass is complete).
        for (uint8 c = 0; c < CELLS; ++c) {
            if (board[c] != 0) {
                uint8 w = _scanThrough(board, c);
                if (w != 0) return w;
            }
        }
        return 0;
    }

    /// @dev Check the 4 directions (horizontal, vertical, both diagonals) passing through
    ///      `cell`; return the disc colour if a run of >=4 of that colour includes `cell`.
    function _scanThrough(uint8[CELLS] memory board, uint8 cell) internal pure returns (uint8) {
        uint8 disc = board[cell];
        if (disc == 0) return 0;
        // direction (dRow, dCol): right, up, up-right, up-left
        int8[4] memory dRow = [int8(0), int8(1), int8(1), int8(1)];
        int8[4] memory dCol = [int8(1), int8(0), int8(1), int8(-1)];
        for (uint8 d = 0; d < 4; ++d) {
            uint8 run = 1
                + _count(board, cell, dRow[d], dCol[d], disc)
                + _count(board, cell, -dRow[d], -dCol[d], disc);
            if (run >= 4) return disc;
        }
        return 0;
    }

    /// @dev Count consecutive `disc` cells stepping (dRow,dCol) from `cell` (exclusive).
    function _count(
        uint8[CELLS] memory board,
        uint8 cell,
        int8 dRow,
        int8 dCol,
        uint8 disc
    ) internal pure returns (uint8 n) {
        int8 r = int8(uint8(cell / COLS)) + dRow;
        int8 c = int8(uint8(cell % COLS)) + dCol;
        while (r >= 0 && r < int8(uint8(ROWS)) && c >= 0 && c < int8(uint8(COLS))) {
            if (board[uint8(r) * COLS + uint8(c)] != disc) break;
            ++n;
            r += dRow;
            c += dCol;
        }
    }
}
