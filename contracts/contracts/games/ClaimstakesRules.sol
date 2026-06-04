// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title ClaimstakesRules — dots-and-boxes on a configurable grid for the GameTable engine.
/// @notice Two players take turns drawing one edge between adjacent dots. Completing the
///         fourth side of a 1x1 box claims it for the mover. When every box is claimed the
///         player owning the most boxes wins; an equal split is a draw. The default board is
///         5x5 dots => 4x4 = 16 boxes (an EVEN total, so a draw IS possible there); odd box
///         totals (e.g. 3x3=9) cannot draw. Both draw and decisive paths are supported.
///
/// @dev EXTRA-TURN HANDLING (the GameTable rotation collision): GameTable enforces strict
///      alternation, but completing a box grants the mover ANOTHER edge. We encode the whole
///      chain into ONE move: a `move` is an ARRAY of edge indices (the streak), validated and
///      applied atomically in {applyMove}. Each edge after the first is ONLY legal if the
///      IMMEDIATELY PRECEDING edge completed >= 1 box (earned the extra turn). The streak MUST
///      end on an edge that completes NO box (which passes the turn) UNLESS that edge was the
///      final edge of the board (terminal). The player submits their full streak as one tx.
///
/// @dev GRID / EDGE INDEXING (spelled out). Config = abi.encode(uint8 cols, uint8 rows) where
///      cols/rows are the number of BOXES per row / column (dots = cols+1 by rows+1). Default
///      (empty config) is 4x4 boxes = a 5x5 dot grid. Cap is 8x8 boxes.
///        - HORIZONTAL edges come FIRST, row-major. There are (rows+1) horizontal lines, each
///          with `cols` edges. Horizontal edge (hr, hc) — hr in 0..rows, hc in 0..cols-1 — has
///          index  hr*cols + hc.   Count H = (rows+1)*cols.
///        - VERTICAL edges come AFTER all horizontals, row-major. There are `rows` lines, each
///          with (cols+1) edges. Vertical edge (vr, vc) — vr in 0..rows-1, vc in 0..cols — has
///          index  H + vr*(cols+1) + vc.   Count V = rows*(cols+1).
///        - Total edges E = H + V. Box (br, bc) — br in 0..rows-1, bc in 0..cols-1 — is bounded
///          by: top = br*cols + bc, bottom = (br+1)*cols + bc, left = H + br*(cols+1) + bc,
///          right = H + br*(cols+1) + bc + 1.
///
/// @dev STATE ENCODING (abi.encode, stateless — all match state lives in GameTable):
///        (uint8 cols, uint8 rows, bool[] edges, uint8[] boxes, uint8 toMove,
///         uint16 claimed)
///      - cols/rows: box dimensions (echo of config).
///      - edges: length E bitmap; edges[i] = true once drawn.
///      - boxes: length cols*rows; boxes[b] = owner (0 = unclaimed, 1 or 2). Box index is
///        br*cols + bc (row-major).
///      - toMove: 1-based player to move.
///      - claimed: number of boxes claimed so far (terminal when == cols*rows).
contract ClaimstakesRules is IGameRules {
    uint8 internal constant MAX_DIM = 8;
    uint8 internal constant DEFAULT_DIM = 4;

    error BadPlayerCount();
    error BadPlayer();
    error BadConfig();
    error GameOver();
    error EmptyMove();
    error EdgeOutOfRange();
    error EdgeTaken();
    error NoExtraTurn();
    error MustContinue();

    /// @inheritdoc IGameRules
    function initialState(bytes calldata config, uint8 numPlayers)
        external
        pure
        returns (bytes memory)
    {
        if (numPlayers != 2) revert BadPlayerCount();
        (uint8 cols, uint8 rows) = _dims(config);

        uint256 e = _edgeCount(cols, rows);
        bool[] memory edges = new bool[](e);
        uint8[] memory boxes = new uint8[](uint256(cols) * rows);
        return abi.encode(cols, rows, edges, boxes, uint8(1), uint16(0));
    }

    /// @inheritdoc IGameRules
    /// @dev Applies the full streak atomically; reverts on any illegal continuation.
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        if (playerIndex > 1) revert BadPlayer();
        (
            uint8 cols,
            uint8 rows,
            bool[] memory edges,
            uint8[] memory boxes,
            uint8 toMove,
            uint16 claimed
        ) = abi.decode(state, (uint8, uint8, bool[], uint8[], uint8, uint16));

        uint16 total = uint16(uint256(cols) * rows);
        if (claimed >= total) revert GameOver();
        if (playerIndex + 1 != toMove) revert BadPlayer();

        uint256[] memory chosen = abi.decode(move, (uint256[]));
        if (chosen.length == 0) revert EmptyMove();

        claimed = _runStreak(cols, rows, edges, boxes, toMove, claimed, chosen);

        if (claimed >= total) {
            return abi.encode(cols, rows, edges, boxes, toMove, claimed);
        }
        uint8 next = toMove == 1 ? 2 : 1;
        return abi.encode(cols, rows, edges, boxes, next, claimed);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        (
            uint8 cols,
            uint8 rows,
            ,
            uint8[] memory boxes,
            ,
            uint16 claimed
        ) = abi.decode(state, (uint8, uint8, bool[], uint8[], uint8, uint16));

        uint16 total = uint16(uint256(cols) * rows);
        if (claimed < total) return 0;

        uint16 c1;
        for (uint256 b = 0; b < boxes.length; ++b) {
            if (boxes[b] == 1) ++c1;
        }
        uint16 c2 = total - c1;
        if (c1 > c2) return 1;
        if (c2 > c1) return 2;
        return 255; // draw (only reachable on even box totals)
    }

    /// @inheritdoc IGameRules
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "Claimstakes";
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

    /// @dev Decode config -> box dims, applying default + cap checks.
    function _dims(bytes calldata config) internal pure returns (uint8 cols, uint8 rows) {
        if (config.length == 0) return (DEFAULT_DIM, DEFAULT_DIM);
        (cols, rows) = abi.decode(config, (uint8, uint8));
        if (cols == 0 || rows == 0 || cols > MAX_DIM || rows > MAX_DIM) revert BadConfig();
    }

    /// @dev Total edge count E = horizontals + verticals.
    function _edgeCount(uint8 cols, uint8 rows) internal pure returns (uint256) {
        uint256 h = uint256(rows + 1) * cols;
        uint256 v = uint256(rows) * (cols + 1);
        return h + v;
    }

    /// @dev Apply each edge in the streak, returning the updated claimed-box count. Each edge
    ///      after the first requires the previous edge to have completed a box.
    function _runStreak(
        uint8 cols,
        uint8 rows,
        bool[] memory edges,
        uint8[] memory boxes,
        uint8 toMove,
        uint16 claimed,
        uint256[] memory chosen
    ) internal pure returns (uint16) {
        uint16 total = uint16(uint256(cols) * rows);
        bool prevScored = true; // first edge is always allowed
        for (uint256 k = 0; k < chosen.length; ++k) {
            if (!prevScored) revert NoExtraTurn();
            if (claimed >= total) revert NoExtraTurn(); // board already finished
            uint8 gained = _draw(cols, rows, edges, boxes, toMove, chosen[k]);
            claimed += gained;
            prevScored = gained > 0;
        }
        // A streak that ended on a scoring edge must continue (unless board is now terminal).
        if (prevScored && claimed < total) revert MustContinue();
        return claimed;
    }

    /// @dev Draw one edge; claim any boxes it completes for `toMove`. Returns # boxes claimed
    ///      by this single edge (0, 1, or 2).
    function _draw(
        uint8 cols,
        uint8 rows,
        bool[] memory edges,
        uint8[] memory boxes,
        uint8 toMove,
        uint256 edge
    ) internal pure returns (uint8 gained) {
        if (edge >= edges.length) revert EdgeOutOfRange();
        if (edges[edge]) revert EdgeTaken();
        edges[edge] = true;

        uint256 h = uint256(rows + 1) * cols;
        if (edge < h) {
            // Horizontal edge: bounds the box above it and the box below it.
            uint256 hr = edge / cols;
            uint256 hc = edge % cols;
            if (hr > 0) gained += _tryClaim(cols, edges, boxes, toMove, hr - 1, hc, h);
            if (hr < rows) gained += _tryClaim(cols, edges, boxes, toMove, hr, hc, h);
        } else {
            // Vertical edge: bounds the box left of it and the box right of it.
            uint256 idx = edge - h;
            uint256 vr = idx / (cols + 1);
            uint256 vc = idx % (cols + 1);
            if (vc > 0) gained += _tryClaim(cols, edges, boxes, toMove, vr, vc - 1, h);
            if (vc < cols) gained += _tryClaim(cols, edges, boxes, toMove, vr, vc, h);
        }
    }

    /// @dev If box (br,bc) is unclaimed and now has all four edges, claim it for `toMove`.
    function _tryClaim(
        uint8 cols,
        bool[] memory edges,
        uint8[] memory boxes,
        uint8 toMove,
        uint256 br,
        uint256 bc,
        uint256 h
    ) internal pure returns (uint8) {
        uint256 b = br * cols + bc;
        if (boxes[b] != 0) return 0;
        if (!_complete(cols, edges, br, bc, h)) return 0;
        boxes[b] = toMove;
        return 1;
    }

    /// @dev True when all four edges of box (br,bc) are drawn.
    function _complete(
        uint8 cols,
        bool[] memory edges,
        uint256 br,
        uint256 bc,
        uint256 h
    ) internal pure returns (bool) {
        uint256 top = br * cols + bc;
        uint256 bottom = (br + 1) * cols + bc;
        uint256 left = h + br * (cols + 1) + bc;
        uint256 right = left + 1;
        return edges[top] && edges[bottom] && edges[left] && edges[right];
    }
}
