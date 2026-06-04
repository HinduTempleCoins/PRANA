// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title CrownsRules — English draughts / checkers (8×8) rules for GameTable.
/// @notice Standard English draughts: men move one diagonal step forward and capture one
///         step diagonally forward by jumping; kings (made on reaching the back rank) move
///         and capture one step diagonally in BOTH directions. Captures are MANDATORY: if any
///         capture is available the player MUST capture. A multi-jump continues with the SAME
///         piece. Win when the opponent has no pieces OR no legal move. A 40-ply run with no
///         capture (and no man advance — see counter rule below) is a draw.
///
/// @dev STATE ENCODING (abi.encode of 3 fields, stateless):
///        (uint8[32] sq, uint8 sideToMove, uint8 noProgress)
///      - sq: the 32 dark (playable) squares, numbered 0..31 in reading order over dark
///        cells. Mapping to (row, col): row = s / 4 (row 0 is the TOP, player-2's back rank,
///        row 7 is player-1's back rank). Within a row the four dark columns are:
///          even rows (0,2,4,6): cols 1,3,5,7   →  col = 2*(s%4) + 1
///          odd  rows (1,3,5,7): cols 0,2,4,6   →  col = 2*(s%4)
///        Cell value: 0 empty · 1 man-P1 · 2 man-P2 · 3 king-P1 · 4 king-P2.
///      - Orientation: PLAYER 1 starts on the high rows (6,7,…) and moves UP (decreasing row);
///        PLAYER 2 starts on the low rows (0,1,…) and moves DOWN (increasing row). A P1 man
///        reaching row 0 is crowned; a P2 man reaching row 7 is crowned.
///      - sideToMove: 1 or 2, the player whose turn it is (GameTable rotates strictly).
///      - noProgress: plies since the last capture or man move; 40 ⇒ draw.
///
///      MOVE ENCODING: abi.encode(uint8[] path). path[0] = from square; each subsequent entry
///        is the landing square of one hop. A SIMPLE (non-capturing) move is a 2-entry path of
///        adjacent diagonal squares. A CAPTURE is a path where each hop jumps over (and
///        removes) an enemy piece; multi-jumps are the FULL chain submitted as ONE move
///        (path length >= 3). Because GameTable rotates turns strictly, the entire jump chain
///        of one piece must be encoded in a single applyMove call — partial chains revert.
///
///      playerIndex is 0-based from GameTable; the side colour is playerIndex+1 and MUST equal
///      state.sideToMove (defensive check).
contract CrownsRules is IGameRules {
    uint8 internal constant N = 32;
    uint8 internal constant DRAW_PLIES = 40;

    /// @inheritdoc IGameRules
    function initialState(bytes calldata, uint8 numPlayers)
        external
        pure
        returns (bytes memory)
    {
        require(numPlayers == 2, "Crowns: 2 players");
        uint8[N] memory sq;
        // P2 fills top three rows (squares 0..11), P1 fills bottom three (20..31).
        for (uint8 s = 0; s < 12; ++s) sq[s] = 2;
        for (uint8 s = 20; s < N; ++s) sq[s] = 1;
        return abi.encode(sq, uint8(1), uint8(0));
    }

    /// @inheritdoc IGameRules
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        (uint8[N] memory sq, uint8 side, uint8 noProgress) =
            abi.decode(state, (uint8[32], uint8, uint8));
        require(_winnerOf(sq, side) == 0, "Crowns: over");
        require(playerIndex + 1 == side, "Crowns: not your turn");

        uint8[] memory path = abi.decode(move, (uint8[]));
        require(path.length >= 2, "Crowns: short path");

        bool captured = _execute(sq, side, path);
        bool advanced = _wasManMove(sq, path, side, captured);

        uint8 nextNoProgress = (captured || advanced) ? 0 : noProgress + 1;
        return abi.encode(sq, side == 1 ? uint8(2) : uint8(1), nextNoProgress);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        (uint8[N] memory sq, uint8 side, uint8 noProgress) =
            abi.decode(state, (uint8[32], uint8, uint8));
        uint8 w = _winnerOf(sq, side);
        if (w != 0) return w;
        if (noProgress >= DRAW_PLIES) return 255;
        return 0;
    }

    /// @inheritdoc IGameRules
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "Crowns";
    }

    function minPlayers() external pure returns (uint8) {
        return 2;
    }

    function maxPlayers() external pure returns (uint8) {
        return 2;
    }

    // ============================================================ move execution

    /// @dev Validate + apply `path`. Returns true if the move was a capture. Enforces the
    ///      mandatory-capture rule: a non-capturing path reverts when any capture exists.
    function _execute(uint8[N] memory sq, uint8 side, uint8[] memory path)
        internal
        pure
        returns (bool)
    {
        uint8 from = path[0];
        uint8 piece = sq[from];
        require(from < N && _owns(piece, side), "Crowns: not your piece");

        bool mustCapture = _anyCaptureExists(sq, side);
        bool isCapture = _isJump(from, path[1]);
        require(isCapture || !mustCapture, "Crowns: must capture");

        if (isCapture) {
            _applyCaptureChain(sq, side, path);
        } else {
            require(path.length == 2, "Crowns: simple is 2");
            _applySimple(sq, side, from, path[1]);
        }
        return isCapture;
    }

    /// @dev A single non-capturing diagonal step.
    function _applySimple(uint8[N] memory sq, uint8 side, uint8 from, uint8 to) internal pure {
        require(sq[to] == 0, "Crowns: occupied");
        require(_isStep(from, to) && _dirOk(sq[from], from, to), "Crowns: bad step");
        _settle(sq, side, from, to);
    }

    /// @dev Apply a (possibly multi-) jump chain. Each hop must capture; after the chain, if
    ///      the moved piece can still capture, the chain was incomplete → revert.
    function _applyCaptureChain(uint8[N] memory sq, uint8 side, uint8[] memory path)
        internal
        pure
    {
        uint8 cur = path[0];
        for (uint256 i = 1; i < path.length; ++i) {
            cur = _applyOneJump(sq, side, cur, path[i]);
        }
        require(!_pieceCanCapture(sq, side, cur), "Crowns: chain incomplete");
    }

    /// @dev Apply one jump from `cur` to `dest`, removing the jumped enemy; returns landing.
    function _applyOneJump(uint8[N] memory sq, uint8 side, uint8 cur, uint8 dest)
        internal
        pure
        returns (uint8)
    {
        require(sq[dest] == 0 && _isJump(cur, dest), "Crowns: bad jump");
        require(_dirOk(sq[cur], cur, dest), "Crowns: bad dir");
        uint8 mid = _midSquare(cur, dest);
        require(_isEnemy(sq[mid], side), "Crowns: no victim");
        sq[mid] = 0;
        _settle(sq, side, cur, dest);
        return dest;
    }

    /// @dev Move the piece from→to and crown it if it reached the far back rank.
    function _settle(uint8[N] memory sq, uint8 side, uint8 from, uint8 to) internal pure {
        uint8 piece = sq[from];
        sq[from] = 0;
        uint8 row = to / 4;
        if (piece == 1 && row == 0) piece = 3; // P1 man crowned at top
        else if (piece == 2 && row == 7) piece = 4; // P2 man crowned at bottom
        sq[to] = piece;
    }

    // ============================================================ capture scans

    /// @dev Does `side` have ANY capture available on the board?
    function _anyCaptureExists(uint8[N] memory sq, uint8 side) internal pure returns (bool) {
        for (uint8 s = 0; s < N; ++s) {
            if (_owns(sq[s], side) && _pieceCanCapture(sq, side, s)) return true;
        }
        return false;
    }

    /// @dev Can the piece at `from` capture in any of its legal directions?
    function _pieceCanCapture(uint8[N] memory sq, uint8 side, uint8 from)
        internal
        pure
        returns (bool)
    {
        int8[4] memory dr = [int8(-1), int8(-1), int8(1), int8(1)];
        int8[4] memory dc = [int8(-1), int8(1), int8(-1), int8(1)];
        for (uint8 d = 0; d < 4; ++d) {
            if (_canJumpDir(sq, side, from, dr[d], dc[d])) return true;
        }
        return false;
    }

    /// @dev Capture possible from `from` stepping diagonally (dr,dc): enemy adjacent, empty
    ///      beyond, and direction legal for the piece (men only forward).
    function _canJumpDir(uint8[N] memory sq, uint8 side, uint8 from, int8 dr, int8 dc)
        internal
        pure
        returns (bool)
    {
        (int8 r, int8 c) = _rc(from);
        int8 mr = r + dr;
        int8 mc = c + dc;
        int8 lr = r + 2 * dr;
        int8 lc = c + 2 * dc;
        if (!_inBounds(lr, lc)) return false;
        if (!_forwardOk(sq[from], dr)) return false;
        uint8 mid = _sq(uint8(uint8(mr)), uint8(uint8(mc)));
        uint8 land = _sq(uint8(uint8(lr)), uint8(uint8(lc)));
        return _isEnemy(sq[mid], side) && sq[land] == 0;
    }

    // ============================================================ legality / win

    /// @dev Winner if the game is decided for the player to move (`side`), else 0. The side to
    ///      move loses (opponent wins) when it has no pieces or no legal move.
    function _winnerOf(uint8[N] memory sq, uint8 side) internal pure returns (uint8) {
        bool hasPiece;
        bool hasMove;
        for (uint8 s = 0; s < N; ++s) {
            if (_owns(sq[s], side)) {
                hasPiece = true;
                if (_pieceCanCapture(sq, side, s) || _pieceCanStep(sq, side, s)) {
                    hasMove = true;
                    break;
                }
            }
        }
        if (hasPiece && hasMove) return 0;
        return side == 1 ? 2 : 1; // side-to-move is stuck ⇒ opponent wins
    }

    /// @dev Can the piece at `from` make a simple step in any legal direction?
    function _pieceCanStep(uint8[N] memory sq, uint8 side, uint8 from)
        internal
        pure
        returns (bool)
    {
        int8[4] memory dr = [int8(-1), int8(-1), int8(1), int8(1)];
        int8[4] memory dc = [int8(-1), int8(1), int8(-1), int8(1)];
        (int8 r, int8 c) = _rc(from);
        for (uint8 d = 0; d < 4; ++d) {
            int8 nr = r + dr[d];
            int8 nc = c + dc[d];
            if (!_inBounds(nr, nc) || !_forwardOk(sq[from], dr[d])) continue;
            if (sq[_sq(uint8(uint8(nr)), uint8(uint8(nc)))] == 0) return true;
        }
        return false;
    }

    /// @dev Was this a man move (for the no-progress reset)? Any capture already resets; a
    ///      simple move resets only when the moving piece was a man (value 1 or 2 at `from`
    ///      BEFORE settling — recovered from the destination, accounting for crowning).
    function _wasManMove(uint8[N] memory sq, uint8[] memory path, uint8, bool captured)
        internal
        pure
        returns (bool)
    {
        if (captured) return true; // captures always reset noProgress anyway
        uint8 dest = path[path.length - 1];
        uint8 v = sq[dest];
        if (v == 1 || v == 2) return true; // landed as a man ⇒ man move
        // A freshly-crowned man also counts as progress: a king sitting on the back rank it
        // just reached. (A pre-existing king that merely moved along the back rank is a king
        // move and should NOT reset — but men only ever crown by ENTERING the rank, and a king
        // simple-move into the rank from row 1/6 is the same square set; we treat any king now
        // on the FAR back rank for its side as a crowning event.)
        uint8 row = dest / 4;
        if (v == 3 && row == 0) return true; // P1 man just crowned at top
        if (v == 4 && row == 7) return true; // P2 man just crowned at bottom
        return false;
    }

    // ============================================================ geometry utils

    function _owns(uint8 v, uint8 side) internal pure returns (bool) {
        return side == 1 ? (v == 1 || v == 3) : (v == 2 || v == 4);
    }

    function _isEnemy(uint8 v, uint8 side) internal pure returns (bool) {
        return v != 0 && !_owns(v, side);
    }

    /// @dev (row, col) of a dark square index.
    function _rc(uint8 s) internal pure returns (int8 r, int8 c) {
        uint8 row = s / 4;
        uint8 off = s % 4;
        r = int8(uint8(row));
        c = int8(uint8((row % 2 == 0) ? (2 * off + 1) : (2 * off)));
    }

    /// @dev Dark-square index for a (row,col); assumes the cell is a dark/playable square.
    function _sq(uint8 row, uint8 col) internal pure returns (uint8) {
        uint8 off = (row % 2 == 0) ? (col - 1) / 2 : col / 2;
        return row * 4 + off;
    }

    function _inBounds(int8 r, int8 c) internal pure returns (bool) {
        return r >= 0 && r < 8 && c >= 0 && c < 8;
    }

    /// @dev Are two dark squares one diagonal step apart?
    function _isStep(uint8 a, uint8 b) internal pure returns (bool) {
        (int8 ar, int8 ac) = _rc(a);
        (int8 br, int8 bc) = _rc(b);
        int8 dr = br - ar;
        int8 dc = bc - ac;
        return (dr == 1 || dr == -1) && (dc == 1 || dc == -1);
    }

    /// @dev Are two dark squares a diagonal jump (two steps) apart?
    function _isJump(uint8 a, uint8 b) internal pure returns (bool) {
        (int8 ar, int8 ac) = _rc(a);
        (int8 br, int8 bc) = _rc(b);
        int8 dr = br - ar;
        int8 dc = bc - ac;
        return (dr == 2 || dr == -2) && (dc == 2 || dc == -2);
    }

    /// @dev The dark square jumped over between `a` and `b` (a valid jump pair).
    function _midSquare(uint8 a, uint8 b) internal pure returns (uint8) {
        (int8 ar, int8 ac) = _rc(a);
        (int8 br, int8 bc) = _rc(b);
        return _sq(uint8(uint8((ar + br) / 2)), uint8(uint8((ac + bc) / 2)));
    }

    /// @dev Is the row-direction `dr` legal for `piece`? Kings (3,4) move both ways; P1 men
    ///      (1) move UP (dr<0); P2 men (2) move DOWN (dr>0).
    function _forwardOk(uint8 piece, int8 dr) internal pure returns (bool) {
        if (piece == 3 || piece == 4) return true;
        if (piece == 1) return dr < 0;
        return dr > 0; // piece == 2
    }

    /// @dev Direction legality for a concrete from→to (used by simple + jump validators).
    function _dirOk(uint8 piece, uint8 from, uint8 to) internal pure returns (bool) {
        (int8 fr,) = _rc(from);
        (int8 tr,) = _rc(to);
        return _forwardOk(piece, (tr > fr) ? int8(1) : int8(-1));
    }
}
