// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title HarborHuntRules — hidden-board battleship (10×10) rules for the GameTable engine.
/// @notice Two players; a 10×10 grid (100 cells, index = row*10 + col, 0..99). Standard fleet
///         = ships of sizes [5,4,3,3,2] => 17 occupied cells total. Each player keeps their
///         board secret and commits ONLY a Merkle root of it; per-cell truth is revealed lazily
///         and proven against that root as shots land. Lying (a proof that does not verify, or a
///         missing proof) is an instant fraud-forfeit. 17 honest hits sinks a fleet => the
///         shooter wins. This contract is fully stateless — all match state lives in GameTable.
///
/// @dev ── MERKLE LEAF ENCODING (per board cell) ───────────────────────────────────────────
///        leaf = keccak256(abi.encode(uint8 cellIndex, bool isShip, bytes32 perCellSalt))
///      The tree has exactly 100 leaves (one per cell, indices 0..99). `perCellSalt` MUST be a
///      fresh random value per cell so an opponent cannot brute-force `isShip` from the leaf
///      (the board is only 2^100 layouts but a single bit per known cellIndex is trivially
///      guessable without salt). Proofs are verified with OpenZeppelin {MerkleProof.verify},
///      which hashes sibling pairs SORTED (commutative) — JS helpers must mirror that.
///
/// @dev ── STATE ENCODING (abi.encode of a Game tuple) ────────────────────────────────────
///        Game {
///          uint8  phase;        // 0 = SETUP, 1 = BATTLE, 2 = FINISHED
///          uint8  winner;       // 0 ongoing · 1 = p1 won · 2 = p2 won  (255 unused: no draws)
///          uint8  turn;         // whose turn it is in BATTLE: 0 = p1, 1 = p2
///          bytes32[2] roots;    // each player's committed board Merkle root (0 = not yet set)
///          uint8[2] hits;       // confirmed hits each player has SCORED on the opponent
///          bool   pendingSet;   // is there a shot awaiting the opponent's truthful answer?
///          uint8  pendingCell;  // the cell the *current defender* must answer for
///          uint16[2] shotMask;  // OPTIONAL bookkeeping: which cells a player already fired at
///        }
///      `shotMask` is a 100-bit set stored as ... we instead store the fired-at cells as a
///      bool[100] per player flattened — see the concrete tuple in {initialState}. (We keep
///      the docstring list above conceptual; the on-chain tuple is the source of truth.)
///
/// @dev ── BATTLE MOVE ENCODING ────────────────────────────────────────────────────────────
///      A SETUP move (simultaneous) = abi.encode(bytes32 root). Each player submits once.
///      A BATTLE move = abi.encode(
///          bool      hasAnswer,        // false ONLY on the very first shot (nothing pending)
///          bool      answerIsShip,     // truth for the pending cell the mover must answer
///          bytes32   answerSalt,       // perCellSalt for that cell
///          bytes32[] answerProof,      // Merkle proof of (pendingCell, answerIsShip, salt)
///          uint8     myShot            // 0..99 cell this mover now fires at
///      )
///      The mover FIRST answers the opponent's pending shot (proving the truth against the
///      mover's OWN committed root), THEN fires their own shot. If the answer fails to verify,
///      it is fraud => the OTHER player wins immediately. The very first BATTLE move (p1) has
///      nothing to answer, so `hasAnswer` is false and only `myShot` is used.
contract HarborHuntRules is IGameRules {
    error BadPlayerCount();
    error BadConfig();
    error BadStateLength();
    error GameOver();
    error WrongPhase();
    error RootAlreadySet();
    error ZeroRoot();
    error CellOutOfRange();
    error CellAlreadyShot();
    error MissingAnswer();
    error UnexpectedAnswer();
    error NotYourTurn();
    error BadFleet();
    error LengthMismatch();

    uint8 internal constant BOARD = 100; // 10x10
    uint8 internal constant DIM = 10;
    uint8 internal constant FLEET_HITS = 17; // 5+4+3+3+2

    /// @dev The concrete on-chain state tuple. Kept in one struct so encode/decode stay in sync.
    struct Game {
        uint8 phase; // 0 SETUP, 1 BATTLE, 2 FINISHED
        uint8 winner; // 0 ongoing, 1 p1, 2 p2
        uint8 turn; // 0 = p1 to move, 1 = p2 to move (BATTLE only)
        bool pendingSet; // a shot awaits the mover's truthful answer
        uint8 pendingCell; // cell the mover must answer for
        bytes32 root0; // p1 board root
        bytes32 root1; // p2 board root
        uint8 hits0; // hits p1 has scored on p2
        uint8 hits1; // hits p2 has scored on p1
        bool[] shot0; // length 100: cells p1 has fired at (on p2's board)
        bool[] shot1; // length 100: cells p2 has fired at (on p1's board)
    }

    // --------------------------------------------------------------------- //
    //  IGameRules                                                           //
    // --------------------------------------------------------------------- //

    /// @inheritdoc IGameRules
    /// @dev config is ignored (board + fleet are fixed). numPlayers must be 2.
    function initialState(bytes calldata, uint8 numPlayers)
        external
        pure
        returns (bytes memory state)
    {
        if (numPlayers != 2) revert BadPlayerCount();
        Game memory g;
        g.shot0 = new bool[](BOARD);
        g.shot1 = new bool[](BOARD);
        // phase 0 (SETUP), all else zero/false by default.
        return _encode(g);
    }

    /// @inheritdoc IGameRules
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory newState)
    {
        if (playerIndex > 1) revert BadPlayerCount();
        Game memory g = _decode(state);
        if (g.phase == 2) revert GameOver();

        if (g.phase == 0) {
            _applySetup(g, playerIndex, move);
        } else {
            _applyBattle(g, playerIndex, move);
        }
        return _encode(g);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        Game memory g = _decode(state);
        return g.winner; // 0 ongoing, 1 or 2 winner (no draws in battleship)
    }

    /// @inheritdoc IGameRules
    /// @dev SETUP commits are simultaneous; BATTLE is strict turn alternation.
    function simultaneous(bytes calldata state) external pure returns (bool) {
        return _decode(state).phase == 0;
    }

    function gameName() external pure returns (string memory) {
        return "HarborHunt";
    }

    function minPlayers() external pure returns (uint8) {
        return 2;
    }

    function maxPlayers() external pure returns (uint8) {
        return 2;
    }

    // --------------------------------------------------------------------- //
    //  Phase handlers                                                       //
    // --------------------------------------------------------------------- //

    /// @dev SETUP: each player submits their board Merkle root exactly once. When both roots
    ///      are in, advance to BATTLE with p1 (turn 0) to fire first.
    function _applySetup(Game memory g, uint8 playerIndex, bytes calldata move) internal pure {
        bytes32 root = abi.decode(move, (bytes32));
        if (root == bytes32(0)) revert ZeroRoot();

        if (playerIndex == 0) {
            if (g.root0 != bytes32(0)) revert RootAlreadySet();
            g.root0 = root;
        } else {
            if (g.root1 != bytes32(0)) revert RootAlreadySet();
            g.root1 = root;
        }

        if (g.root0 != bytes32(0) && g.root1 != bytes32(0)) {
            g.phase = 1; // BATTLE
            g.turn = 0; // p1 fires first
            g.pendingSet = false;
        }
    }

    /// @dev BATTLE: mover answers the pending shot against their OWN root, then fires.
    function _applyBattle(Game memory g, uint8 playerIndex, bytes calldata move) internal pure {
        if (playerIndex != g.turn) revert NotYourTurn();

        (
            bool hasAnswer,
            bool answerIsShip,
            bytes32 answerSalt,
            bytes32[] memory answerProof,
            uint8 myShot
        ) = abi.decode(move, (bool, bool, bytes32, bytes32[], uint8));

        // 1) Resolve the opponent's previous shot, if any, against the mover's own board.
        if (g.pendingSet) {
            if (!hasAnswer) revert MissingAnswer();
            _resolveAnswer(g, playerIndex, answerIsShip, answerSalt, answerProof);
            if (g.phase == 2) return; // fraud forfeit already settled the game
        } else {
            if (hasAnswer) revert UnexpectedAnswer();
        }

        // 2) Fire the mover's own shot at the opponent.
        _fire(g, playerIndex, myShot);
    }

    /// @dev Verify the truthful answer for `g.pendingCell` against the mover's committed root.
    ///      A failed proof = fraud => the OTHER player wins. A truthful "ship" answer credits
    ///      the opponent (who fired the pending shot) with one hit, possibly ending the game.
    function _resolveAnswer(
        Game memory g,
        uint8 mover,
        bool isShip,
        bytes32 salt,
        bytes32[] memory proof
    ) internal pure {
        bytes32 root = mover == 0 ? g.root0 : g.root1;
        bytes32 leaf = keccak256(abi.encode(g.pendingCell, isShip, salt));
        if (!MerkleProof.verify(proof, root, leaf)) {
            // The mover lied / cannot prove → fraud forfeit, opponent wins.
            g.phase = 2;
            g.winner = mover == 0 ? 2 : 1;
            return;
        }
        if (isShip) {
            // The opponent (the previous shooter) scored a confirmed hit.
            if (mover == 0) {
                g.hits1 += 1; // p2 scored on p1
                if (g.hits1 >= FLEET_HITS) {
                    g.phase = 2;
                    g.winner = 2;
                }
            } else {
                g.hits0 += 1; // p1 scored on p2
                if (g.hits0 >= FLEET_HITS) {
                    g.phase = 2;
                    g.winner = 1;
                }
            }
        }
        g.pendingSet = false;
    }

    /// @dev Record `mover`'s shot at `cell` on the opponent's board; it becomes the new pending
    ///      shot the opponent must answer next turn. Pass turn to the opponent.
    function _fire(Game memory g, uint8 mover, uint8 cell) internal pure {
        if (cell >= BOARD) revert CellOutOfRange();
        if (mover == 0) {
            if (g.shot0[cell]) revert CellAlreadyShot();
            g.shot0[cell] = true;
        } else {
            if (g.shot1[cell]) revert CellAlreadyShot();
            g.shot1[cell] = true;
        }
        g.pendingSet = true;
        g.pendingCell = cell;
        g.turn = mover == 0 ? 1 : 0; // opponent now moves (answers this shot, then fires)
    }

    // --------------------------------------------------------------------- //
    //  Fleet verification (public VIEW, NOT part of IGameRules)             //
    // --------------------------------------------------------------------- //

    /// @notice Verify that a fully-revealed board matches `root` AND is a legal fleet layout
    ///         (ships sized exactly [5,4,3,3,2], each a straight horizontal/vertical run, no
    ///         overlaps, no diagonal/bent ships). Anyone can call this off-chain in a dispute
    ///         window: the IGameRules flow trusts "17 honest hits = win", but a settlement
    ///         wrapper at the GameTable layer MAY open a challenge window and call this to catch
    ///         a player who committed an *illegal* board (e.g. too few ship cells so 17 hits is
    ///         unreachable, or a non-standard fleet). Reverts (BadFleet) on any illegality so it
    ///         doubles as a require-style check; returns true on a fully-legal board.
    /// @param root      The committed board Merkle root to check against.
    /// @param isShip    length-100 array: isShip[i] = is cell i occupied. (row-major, i=r*10+c)
    /// @param salts     length-100 array of per-cell salts used in the leaves.
    /// @dev Verifies every cell's leaf against `root` via a multiproof-free, per-cell loop is
    ///      too costly for 100 proofs; instead the caller supplies the full board and we
    ///      reconstruct the tree to compare its root. The tree is built over leaves in cell
    ///      order 0..99 using the SAME sorted-pair hashing OZ uses, padded to 128 leaves with
    ///      bytes32(0) so the layout is deterministic. JS helpers MUST build the tree the same
    ///      way (128-leaf, cell-ordered, sorted pairs, zero pad).
    function challengeFleet(
        bytes32 root,
        bool[] calldata isShip,
        bytes32[] calldata salts
    ) external pure returns (bool ok) {
        if (isShip.length != BOARD || salts.length != BOARD) revert LengthMismatch();

        // 1) Reconstruct the committed root from the revealed board and compare.
        if (_computeRoot(isShip, salts) != root) revert BadFleet();

        // 2) Validate the fleet layout shape.
        _validateFleet(isShip);
        return true;
    }

    /// @notice Pure helper to recompute a board root from a full reveal (no fleet check).
    ///         Useful for tests/tooling to derive the root to commit in SETUP.
    function computeRoot(bool[] calldata isShip, bytes32[] calldata salts)
        external
        pure
        returns (bytes32)
    {
        if (isShip.length != BOARD || salts.length != BOARD) revert LengthMismatch();
        return _computeRoot(isShip, salts);
    }

    /// @dev Build the 128-leaf (next pow2 ≥ 100) sorted-pair Merkle tree over cell leaves and
    ///      return its root. Empty pad leaves are bytes32(0).
    function _computeRoot(bool[] calldata isShip, bytes32[] calldata salts)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory nodes = new bytes32[](128);
        for (uint256 i = 0; i < BOARD; i++) {
            nodes[i] = keccak256(abi.encode(uint8(i), isShip[i], salts[i]));
        }
        // indices 100..127 stay bytes32(0) as pad leaves.
        uint256 width = 128;
        while (width > 1) {
            uint256 half = width / 2;
            for (uint256 i = 0; i < half; i++) {
                nodes[i] = _hashPair(nodes[2 * i], nodes[2 * i + 1]);
            }
            width = half;
        }
        return nodes[0];
    }

    /// @dev OZ-compatible commutative pair hash.
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b
            ? keccak256(abi.encode(a, b))
            : keccak256(abi.encode(b, a));
    }

    /// @dev Validate the occupied cells form exactly the standard fleet [5,4,3,3,2] of straight,
    ///      non-overlapping ships. Algorithm: scan cells; each ship's start is a ship-cell whose
    ///      left and top neighbours are water. From a start, measure the horizontal run and the
    ///      vertical run; a legal ship extends in exactly one direction (length 1 ships are not
    ///      in this fleet, so a lone cell is illegal). Collect ship lengths and compare (sorted)
    ///      to [5,4,3,3,2]. Also confirm no cell is part of two crossing ships (a '+'/'T' shape):
    ///      we reject any ship-cell that has neighbours in BOTH axes beyond its own run.
    function _validateFleet(bool[] calldata isShip) internal pure {
        uint8[5] memory found; // collected ship lengths (max 5 ships)
        uint8 shipCount;
        uint8 totalCells;

        for (uint256 i = 0; i < BOARD; i++) {
            if (!isShip[i]) continue;
            totalCells += 1;
            if (!_isOrigin(isShip, i)) continue; // only count from each ship's top-left
            if (shipCount >= 5) revert BadFleet(); // too many ships
            found[shipCount] = _shipLen(isShip, i);
            shipCount += 1;
        }

        if (shipCount != 5) revert BadFleet();
        if (totalCells != FLEET_HITS) revert BadFleet();
        _requireFleetMatch(found, [uint8(5), 4, 3, 3, 2]);
    }

    /// @dev True if cell `i` is a ship cell whose left and top neighbours are water — i.e. the
    ///      unique top-left origin of a straight ship.
    function _isOrigin(bool[] calldata isShip, uint256 i) internal pure returns (bool) {
        uint256 c = i % DIM;
        uint256 r = i / DIM;
        bool leftWater = (c == 0) || !isShip[i - 1];
        bool topWater = (r == 0) || !isShip[i - DIM];
        return leftWater && topWater;
    }

    /// @dev Length of the straight ship anchored at origin `i`. Reverts BadFleet on a bent /
    ///      crossing shape (runs in BOTH axes) or a length-1 lone cell (no such ship in fleet).
    function _shipLen(bool[] calldata isShip, uint256 i) internal pure returns (uint8 len) {
        uint8 hRun = _run(isShip, i, 1, DIM - (i % DIM)); // rightwards
        uint8 vRun = _run(isShip, i, DIM, DIM - (i / DIM)); // downwards
        if (hRun > 1 && vRun > 1) revert BadFleet(); // bent / crossing
        len = hRun >= vRun ? hRun : vRun;
        if (len < 2) revert BadFleet(); // lone cell — not a standard ship
    }

    /// @dev Count consecutive ship cells from `start` stepping by `step`, at most `maxSteps`.
    function _run(bool[] calldata isShip, uint256 start, uint256 step, uint256 maxSteps)
        internal
        pure
        returns (uint8 n)
    {
        for (uint256 k = 0; k < maxSteps; k++) {
            if (!isShip[start + k * step]) break;
            n += 1;
        }
    }

    /// @dev Require the multiset of `found` ship lengths equals `expected` ([5,4,3,3,2]).
    function _requireFleetMatch(uint8[5] memory found, uint8[5] memory expected) internal pure {
        // Selection-sort both descending, then compare element-wise (≤5 elements, cheap).
        _sortDesc(found);
        _sortDesc(expected);
        for (uint256 i = 0; i < 5; i++) {
            if (found[i] != expected[i]) revert BadFleet();
        }
    }

    /// @dev In-place descending selection sort of a fixed length-5 array.
    function _sortDesc(uint8[5] memory a) internal pure {
        for (uint256 i = 0; i < 5; i++) {
            uint256 max = i;
            for (uint256 j = i + 1; j < 5; j++) {
                if (a[j] > a[max]) max = j;
            }
            if (max != i) {
                uint8 t = a[i];
                a[i] = a[max];
                a[max] = t;
            }
        }
    }

    // --------------------------------------------------------------------- //
    //  Encode / decode                                                      //
    // --------------------------------------------------------------------- //

    function _encode(Game memory g) internal pure returns (bytes memory) {
        return abi.encode(g);
    }

    function _decode(bytes calldata state) internal pure returns (Game memory g) {
        g = abi.decode(state, (Game));
        if (g.shot0.length != BOARD || g.shot1.length != BOARD) revert BadStateLength();
    }
}
