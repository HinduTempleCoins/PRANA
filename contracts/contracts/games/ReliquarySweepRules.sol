// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title ReliquarySweepRules — committer-vs-guesser minesweeper for the GameTable engine.
/// @notice A 2-player {IGameRules} implementation. Player 0 (the SETTER) commits a W×H board
///         (which cells are mines + each cell's adjacent-mine count) as a Merkle root; player 1
///         (the SWEEPER) picks cells one at a time. The setter must reveal each picked cell with
///         a proof: a mine ends the match (setter wins); a safe cell is banked. The sweeper may
///         CASH OUT at any time (winning with their banked count as score metadata) or keep going
///         to clear every safe cell (clearing all W*H − mines safe cells wins outright). A setter
///         reveal whose `adjacentCount` contradicts a neighbouring revealed cell forfeits the
///         match to the sweeper.
///
/// @dev    Rules contracts are STATELESS — all match state lives in the opaque `bytes` blob.
///         GameTable owns turn rotation, stakes, deadlines and settlement.
///
///         ── WAGER NOTE ──
///         Rules are intentionally BINARY win/lose (no payout curve): on cash-out the sweeper
///         simply WINS, with the banked-safe-cell count carried as score metadata for indexers.
///         Wager fairness (the more cells you bank the more you risk vs. reward) comes from
///         GameTable's stake symmetry; a proper risk/payout-curve variant needs a custom table.
///
///         ── BOARD / CELL ENCODING ──
///         Cells are indexed row-major: index = y * width + x, for 0 ≤ x < width, 0 ≤ y < height.
///         `adjacentCount` is the number of mines among a cell's ≤8 orthogonal/diagonal
///         neighbours (a mine cell still carries a count but the game ends before it matters).
///
///         ── MERKLE LEAF ──
///             leaf = keccak256(bytes.concat(keccak256(abi.encode(
///                       uint8 cellIndex, bool isMine, uint8 adjacentCount, bytes32 salt))))
///         Each cell uses a fresh random `salt`.
///
///         ── CONFIG (to {initialState}) ──
///         abi.encode(uint8 width, uint8 height, uint8 mines, uint8 minCells). Empty config ⇒
///         8×8, 10 mines, minCells 10. Requires width,height in 1..16 (so cellIndex ≤ 255 and
///         the seen bitmap fits 256 bits), 1 ≤ mines < width*height. `minCells` is advisory
///         metadata for the front-end's "safe to cash out" hint; it does NOT gate the win.
///
///         ── MOVE ENCODING ──  match flow: SETUP → (PICK → REVEAL)*
///         • SETUP (setter, player 0, phase=0): abi.encode(bytes32 merkleRoot).
///         • PICK (sweeper, player 1, phase=1): abi.encode(uint8 cellIndex, bool cashOut).
///             cashOut = true ends the match immediately: sweeper WINS (cellIndex ignored).
///             cashOut = false requests a reveal of a not-yet-picked in-range cell.
///         • REVEAL (setter, player 0, phase=2): prove the pending cell —
///             abi.encode(bool isMine, uint8 adjacentCount, bytes32 salt, bytes32[] proof).
///             Mine ⇒ setter wins. Safe ⇒ banked; if all safe cells are now banked the sweeper
///             wins outright, else back to PICK. An adjacentCount inconsistent with an already
///             revealed neighbour ⇒ setter fraud forfeit.
///
///         ── STATE ENCODING (opaque blob) ──
///         abi.encode(
///           uint8   width,
///           uint8   height,
///           uint8   mines,
///           uint8   minCells,     // advisory cash-out hint (not enforced)
///           uint8   phase,        // 0 SETUP · 1 PICK · 2 REVEAL
///           uint8   banked,       // safe cells banked so far (sweeper's score metadata)
///           uint8   pending,      // cell index awaiting reveal (valid in phase 2)
///           bytes32 root,         // committed board Merkle root
///           uint256 seenMask,     // bit c set ⇒ cell c has been picked & revealed
///           uint256 mineMask,     // bit c set ⇒ cell c was revealed as a mine (unused post-end)
///           bytes   counts,       // per-cell adjacentCount+1 (0 = unrevealed) for cross-checks
///           uint8   result        // 0 ongoing · 1 setter won · 2 sweeper won
///         )
contract ReliquarySweepRules is IGameRules {
    uint8 private constant PH_SETUP = 0;
    uint8 private constant PH_PICK = 1;
    uint8 private constant PH_REVEAL = 2;

    uint8 private constant DEF_W = 8;
    uint8 private constant DEF_H = 8;
    uint8 private constant DEF_MINES = 10;
    uint8 private constant DEF_MIN_CELLS = 10;
    uint8 private constant DIM_MAX = 16; // width*height ≤ 256 ⇒ cell index fits uint8 + 256-bit mask

    error UnsupportedPlayerCount(uint8 numPlayers);
    error InvalidConfig();
    error NotYourTurn(uint8 playerIndex);
    error GameOver();
    error CellOutOfRange(uint8 cell);
    error CellAlreadyRevealed(uint8 cell);
    error BadProof(uint8 cell);
    error BadAdjacentCount(uint8 count);

    /// @dev Mirror of the opaque state tuple (keeps functions under the local-var budget).
    struct S {
        uint8 width;
        uint8 height;
        uint8 mines;
        uint8 minCells;
        uint8 phase;
        uint8 banked;
        uint8 pending;
        bytes32 root;
        uint256 seenMask;
        uint256 mineMask;
        bytes counts;
        uint8 result;
    }

    // --------------------------------------------------------------------- //
    //                              IGameRules                               //
    // --------------------------------------------------------------------- //

    function initialState(bytes calldata config, uint8 numPlayers)
        external
        pure
        returns (bytes memory)
    {
        if (numPlayers != 2) revert UnsupportedPlayerCount(numPlayers);
        S memory s;
        if (config.length == 0) {
            (s.width, s.height, s.mines, s.minCells) = (DEF_W, DEF_H, DEF_MINES, DEF_MIN_CELLS);
        } else {
            (s.width, s.height, s.mines, s.minCells) = abi.decode(config, (uint8, uint8, uint8, uint8));
        }
        if (s.width == 0 || s.width > DIM_MAX || s.height == 0 || s.height > DIM_MAX) {
            revert InvalidConfig();
        }
        uint256 total = uint256(s.width) * uint256(s.height);
        if (s.mines == 0 || s.mines >= total) revert InvalidConfig();

        s.phase = PH_SETUP;
        s.counts = new bytes(total);
        return _encode(s);
    }

    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        S memory s = _decode(state);
        if (s.result != 0) revert GameOver();

        if (s.phase == PH_SETUP) {
            _requirePlayer(playerIndex, 0);
            s.root = abi.decode(move, (bytes32));
            s.phase = PH_PICK;
        } else if (s.phase == PH_PICK) {
            _requirePlayer(playerIndex, 1);
            _pick(s, move);
        } else {
            _requirePlayer(playerIndex, 0);
            _reveal(s, move);
        }
        return _encode(s);
    }

    /// @return s 0 = ongoing · 1 = setter (player0) won · 2 = sweeper (player1) won.
    function status(bytes calldata state) external pure returns (uint8 s) {
        return _decode(state).result;
    }

    /// @notice Strictly turn-based (setter ↔ sweeper alternation); not simultaneous.
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "ReliquarySweep";
    }

    function minPlayers() external pure returns (uint8) {
        return 2;
    }

    function maxPlayers() external pure returns (uint8) {
        return 2;
    }

    // --------------------------------------------------------------------- //
    //                            Internal logic                             //
    // --------------------------------------------------------------------- //

    /// @dev Sweeper's move: cash out (instant win) or request the reveal of a fresh cell.
    function _pick(S memory s, bytes calldata move) private pure {
        (uint8 cell, bool cashOut) = abi.decode(move, (uint8, bool));
        if (cashOut) {
            s.result = 2; // sweeper banks and walks ⇒ sweeper wins (banked = score metadata)
            return;
        }
        uint256 total = uint256(s.width) * uint256(s.height);
        if (cell >= total) revert CellOutOfRange(cell);
        if (s.seenMask & (uint256(1) << cell) != 0) revert CellAlreadyRevealed(cell);
        s.pending = cell;
        s.phase = PH_REVEAL;
    }

    /// @dev Setter's reveal of the pending cell: verify the proof, apply mine/safe outcome, and
    ///      cross-check the adjacent count against already-revealed neighbours.
    function _reveal(S memory s, bytes calldata move) private pure {
        (bool isMine, uint8 adjacentCount, bytes32 salt, bytes32[] memory proof) =
            abi.decode(move, (bool, uint8, bytes32, bytes32[]));
        if (adjacentCount > 8) revert BadAdjacentCount(adjacentCount);

        uint8 cell = s.pending;
        bytes32 leaf =
            keccak256(bytes.concat(keccak256(abi.encode(cell, isMine, adjacentCount, salt))));
        if (!MerkleProof.verify(proof, s.root, leaf)) revert BadProof(cell);

        s.seenMask |= (uint256(1) << cell);

        if (isMine) {
            s.mineMask |= (uint256(1) << cell);
            s.result = 1; // sweeper hit a mine ⇒ setter wins
            return;
        }

        s.counts[cell] = bytes1(adjacentCount + 1); // +1 so 0 stays "unrevealed"; record before check

        if (_adjacencyContradiction(s, cell)) {
            s.result = 2; // committed board is internally impossible ⇒ setter fraud ⇒ sweeper wins
            return;
        }
        s.banked += 1;

        // Cleared every safe cell (total − mines) ⇒ sweeper wins outright.
        uint256 total = uint256(s.width) * uint256(s.height);
        if (uint256(s.banked) == total - uint256(s.mines)) {
            s.result = 2;
            return;
        }
        s.phase = PH_PICK;
    }

    /// @dev SOUND consistency check on the COMMITTED board (no false positives). Each revealed
    ///      safe cell carries a committed `adjacentCount` = exactly how many of its neighbours are
    ///      mines. All revealed cells in normal play are SAFE (a mine ends the match), so for any
    ///      revealed cell its mine-neighbours must lie among its STILL-UNREVEALED neighbours. If a
    ///      cell's committed count exceeds the number of its neighbours that are still unrevealed
    ///      (i.e. it would need more mines than there are remaining candidate cells), the board is
    ///      internally impossible ⇒ the setter committed a fraudulent board. We re-check the just-
    ///      revealed cell AND each of its already-revealed neighbours (whose unrevealed-candidate
    ///      pool just shrank by one). Counts are read from `s.counts` (value − 1 = real count).
    function _adjacencyContradiction(S memory s, uint8 cell) private pure returns (bool) {
        if (_cellImpossible(s, cell)) return true;
        uint8 w = s.width;
        int256 cx = int256(uint256(cell % w));
        int256 cy = int256(uint256(cell / w));
        for (int256 dy = -1; dy <= 1; dy++) {
            for (int256 dx = -1; dx <= 1; dx++) {
                if (dx == 0 && dy == 0) continue;
                int256 nx = cx + dx;
                int256 ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= int256(uint256(w)) || ny >= int256(uint256(s.height))) {
                    continue;
                }
                uint8 ni = uint8(uint256(ny) * uint256(w) + uint256(nx));
                if (s.counts[ni] != 0 && _cellImpossible(s, ni)) return true; // revealed neighbour
            }
        }
        return false;
    }

    /// @dev True when revealed cell `c`'s committed mine-count exceeds the count of its neighbours
    ///      that are still unrevealed (the only cells that can still be mines).
    function _cellImpossible(S memory s, uint8 c) private pure returns (bool) {
        uint8 w = s.width;
        uint8 need = uint8(s.counts[c]) - 1; // real committed adjacent-mine count
        uint8 candidates = 0;
        int256 cx = int256(uint256(c % w));
        int256 cy = int256(uint256(c / w));
        for (int256 dy = -1; dy <= 1; dy++) {
            for (int256 dx = -1; dx <= 1; dx++) {
                if (dx == 0 && dy == 0) continue;
                int256 nx = cx + dx;
                int256 ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= int256(uint256(w)) || ny >= int256(uint256(s.height))) {
                    continue;
                }
                uint8 ni = uint8(uint256(ny) * uint256(w) + uint256(nx));
                if (s.counts[ni] == 0) candidates++; // unrevealed ⇒ could still be a mine
            }
        }
        return need > candidates;
    }

    function _requirePlayer(uint8 actual, uint8 expected) private pure {
        if (actual != expected) revert NotYourTurn(actual);
    }

    function _encode(S memory s) private pure returns (bytes memory) {
        // Whole-struct encode: identical tuple layout, stack-light (16-slot limit).
        return abi.encode(s);
    }

    function _decode(bytes calldata state) private pure returns (S memory s) {
        // Whole-struct decode: identical tuple layout, stack-light.
        s = abi.decode(state, (S));
    }
}
