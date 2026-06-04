// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title EchoMatchRules — memory / concentration ("pairs") vs a committed shuffled deck.
/// @notice Two players, a face-down deck of `2 * pairCount` cards laid at positions 0..2N-1.
///         Only the DEALER (player 0) shuffles and commits the deck as a Merkle root; the
///         guesser (player 1) commits nothing. Players then alternate (dealer included) flipping
///         two positions per move, proving each flipped card against the committed root. A move
///         that reveals two equal cardIds scores a pair for the mover; the matched positions stay
///         face-up and out of play. When every pair is found, the higher score wins (tie = draw).
///         A flip proof that does not verify (a lie about a card) is an instant fraud-forfeit.
///         This contract is fully stateless — all match state lives in GameTable.
///
/// @dev ── DEALER ASYMMETRY (documented honestly) ─────────────────────────────────────────
///      The dealer KNOWS the deck (they shuffled it), so they can play perfectly from memory
///      while the guesser must learn the layout from reveals. This is an inherent, unavoidable
///      information asymmetry of "one party commits a hidden board the other probes." Mitigate
///      it at the GameTable layer, NOT here: e.g. (a) make the dealer stake more, or (b) rotate
///      the dealer role across a best-of-N series so each player deals an equal number of games.
///      We deliberately keep the rules neutral and let the table choose the fairness policy.
///
/// @dev ── DEVIATION FROM CLASSIC RULES ───────────────────────────────────────────────────
///      In traditional Concentration, finding a pair grants the mover ANOTHER turn. GameTable
///      rotates turns strictly, so encoding a variable-length "streak as one move" would bloat
///      the move format. This version therefore does NOT grant extra turns: every move is
///      exactly one two-card flip and the turn always passes. Scoring is still by pairs found,
///      so the game stays a fair memory contest; only the extra-turn reward is dropped.
///
/// @dev ── MERKLE LEAF ENCODING (per deck position) ───────────────────────────────────────
///        leaf = keccak256(abi.encode(uint8 position, uint8 cardId, bytes32 salt))
///      There are `2 * pairCount` leaves, one per position 0..2N-1. Each of the N distinct
///      cardIds (0..N-1) appears at exactly two positions. A fresh random `salt` per position
///      hides the card from anyone holding only the leaf. Proofs verify with OpenZeppelin
///      {MerkleProof.verify} (sorted/commutative sibling pairs); JS helpers must mirror that.
///
/// @dev ── STATE ENCODING (abi.encode of a Game tuple) ────────────────────────────────────
///        Game {
///          uint8   phase;       // 0 SETUP, 1 PLAY, 2 FINISHED
///          uint8   pairCount;   // N pairs (deck = 2N positions), ≤ 32
///          uint8   winner;      // 0 ongoing · 1 = p1 won · 2 = p2 won · 255 = draw
///          bytes32 root;        // dealer's committed deck root (0 = not yet set)
///          bool    dealerAcked; // dealer (p0) has committed the root
///          bool    guesserAcked;// guesser (p1) has sent the empty SETUP ack
///          uint8   turn;        // 0 = p1 to move, 1 = p2 to move (PLAY only)
///          uint8   foundPairs;  // pairs matched so far (game ends at pairCount)
///          uint8   score0;      // pairs scored by p1
///          uint8   score1;      // pairs scored by p2
///          bool[]  revealed;    // length 2N: position permanently face-up (matched)
///        }
///
/// @dev ── MOVE ENCODING ──────────────────────────────────────────────────────────────────
///      SETUP (simultaneous):
///        - dealer (p0): abi.encode(bytes32 root)  — commit the shuffled deck root.
///        - guesser (p1): abi.encode(bool) any value — an empty ack (no info committed).
///      PLAY (turn-based): abi.encode(
///          uint8 posA, uint8 cardA, bytes32 saltA, bytes32[] proofA,
///          uint8 posB, uint8 cardB, bytes32 saltB, bytes32[] proofB
///      )
///      posA != posB, both unrevealed, both proofs verify against `root`. cardA == cardB ⇒ the
///      mover scores a pair and both positions become permanently revealed.
contract EchoMatchRules is IGameRules {
    error BadPlayerCount();
    error BadConfig();
    error BadStateLength();
    error GameOver();
    error WrongPhase();
    error RootAlreadySet();
    error AlreadyAcked();
    error ZeroRoot();
    error NotYourTurn();
    error PosOutOfRange();
    error SamePosition();
    error PositionRevealed();

    uint8 internal constant MAX_PAIRS = 32;

    struct Game {
        uint8 phase; // 0 SETUP, 1 PLAY, 2 FINISHED
        uint8 pairCount; // N
        uint8 winner; // 0 ongoing, 1 p1, 2 p2, 255 draw
        bytes32 root; // dealer deck root
        bool dealerAcked;
        bool guesserAcked;
        uint8 turn; // 0 = p1, 1 = p2 to move (PLAY)
        uint8 foundPairs;
        uint8 score0;
        uint8 score1;
        bool[] revealed; // length 2N
    }

    // --------------------------------------------------------------------- //
    //  IGameRules                                                           //
    // --------------------------------------------------------------------- //

    /// @inheritdoc IGameRules
    /// @dev config = abi.encode(uint8 pairCount). numPlayers must be 2.
    function initialState(bytes calldata config, uint8 numPlayers)
        external
        pure
        returns (bytes memory state)
    {
        if (numPlayers != 2) revert BadPlayerCount();
        uint8 pairCount = abi.decode(config, (uint8));
        if (pairCount == 0 || pairCount > MAX_PAIRS) revert BadConfig();

        Game memory g;
        g.pairCount = pairCount;
        g.revealed = new bool[](uint256(pairCount) * 2);
        // phase 0 (SETUP); winner 0; all acks false.
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
            _applyPlay(g, playerIndex, move);
        }
        return _encode(g);
    }

    /// @inheritdoc IGameRules
    function status(bytes calldata state) external pure returns (uint8 s) {
        return _decode(state).winner;
    }

    /// @inheritdoc IGameRules
    /// @dev SETUP acks are simultaneous; PLAY is strict alternation.
    function simultaneous(bytes calldata state) external pure returns (bool) {
        return _decode(state).phase == 0;
    }

    function gameName() external pure returns (string memory) {
        return "EchoMatch";
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

    /// @dev SETUP: dealer commits the deck root; guesser sends an empty ack. When both are in,
    ///      advance to PLAY with p1 (turn 0) to move first.
    function _applySetup(Game memory g, uint8 playerIndex, bytes calldata move) internal pure {
        if (playerIndex == 0) {
            if (g.dealerAcked) revert AlreadyAcked();
            bytes32 root = abi.decode(move, (bytes32));
            if (root == bytes32(0)) revert ZeroRoot();
            g.root = root;
            g.dealerAcked = true;
        } else {
            if (g.guesserAcked) revert AlreadyAcked();
            // guesser's move is an empty ack; decode to validate well-formedness only.
            abi.decode(move, (bool));
            g.guesserAcked = true;
        }

        if (g.dealerAcked && g.guesserAcked) {
            g.phase = 1; // PLAY
            g.turn = 0; // p1 moves first
        }
    }

    /// @dev PLAY: mover flips two positions, proving both against the deck root.
    function _applyPlay(Game memory g, uint8 playerIndex, bytes calldata move) internal pure {
        if (playerIndex != g.turn) revert NotYourTurn();

        uint8 cardA;
        uint8 cardB;
        (cardA, cardB) = _verifyFlip(g, move);

        if (cardA == cardB) {
            g.revealed[_posA(move)] = true;
            g.revealed[_posB(move)] = true;
            g.foundPairs += 1;
            if (playerIndex == 0) g.score0 += 1;
            else g.score1 += 1;
        }

        if (g.foundPairs >= g.pairCount) {
            _settle(g);
        } else {
            g.turn = playerIndex == 0 ? 1 : 0; // strict rotation (no extra turn on a match)
        }
    }

    /// @dev Decode the flip, bounds/overlap/revealed-check both positions, and verify both
    ///      Merkle proofs against the deck root. Returns the two revealed cardIds. A failed
    ///      proof = fraud => the OTHER player wins (sets phase=2) and we return equal-but-unused
    ///      cards; callers MUST re-check phase after this returns.
    function _verifyFlip(Game memory g, bytes calldata move)
        internal
        pure
        returns (uint8 cardA, uint8 cardB)
    {
        uint8 deck = g.pairCount * 2;
        uint8 pA = _posA(move);
        uint8 pB = _posB(move);
        if (pA >= deck || pB >= deck) revert PosOutOfRange();
        if (pA == pB) revert SamePosition();
        if (g.revealed[pA] || g.revealed[pB]) revert PositionRevealed();

        cardA = _checkLeaf(g, move, true);
        if (g.phase == 2) return (0, 0);
        cardB = _checkLeaf(g, move, false);
    }

    /// @dev Verify one of the two flips against the root. `first` selects slot A vs slot B.
    ///      On a bad proof, settle a fraud-forfeit (the NON-mover wins) and return 0.
    function _checkLeaf(Game memory g, bytes calldata move, bool first)
        internal
        pure
        returns (uint8 card)
    {
        uint8 pos = first ? _posA(move) : _posB(move);
        bytes32 salt;
        bytes32[] memory proof;
        (card, salt, proof) = _slot(move, first);

        bytes32 leaf = keccak256(abi.encode(pos, card, salt));
        if (!MerkleProof.verify(proof, g.root, leaf)) {
            // The mover lied about a card → fraud forfeit, opponent wins.
            g.phase = 2;
            g.winner = g.turn == 0 ? 2 : 1;
            return 0;
        }
    }

    /// @dev Finalize: all pairs found ⇒ compare scores. Higher wins; equal ⇒ draw (255).
    function _settle(Game memory g) internal pure {
        g.phase = 2;
        if (g.score0 > g.score1) g.winner = 1;
        else if (g.score1 > g.score0) g.winner = 2;
        else g.winner = 255; // draw
    }

    // --------------------------------------------------------------------- //
    //  Move field accessors (decode helpers keep handler locals ≤ 10)       //
    // --------------------------------------------------------------------- //

    function _posA(bytes calldata move) internal pure returns (uint8 p) {
        (p) = abi.decode(move, (uint8));
    }

    function _posB(bytes calldata move) internal pure returns (uint8 p) {
        (, , , , p) = abi.decode(move, (uint8, uint8, bytes32, bytes32[], uint8));
    }

    /// @dev Decode the (card, salt, proof) triple for slot A (`first`=true) or slot B.
    function _slot(bytes calldata move, bool first)
        internal
        pure
        returns (uint8 card, bytes32 salt, bytes32[] memory proof)
    {
        if (first) {
            (, card, salt, proof) = abi.decode(move, (uint8, uint8, bytes32, bytes32[]));
        } else {
            (, , , , , card, salt, proof) =
                abi.decode(move, (uint8, uint8, bytes32, bytes32[], uint8, uint8, bytes32, bytes32[]));
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
        if (g.revealed.length != uint256(g.pairCount) * 2) revert BadStateLength();
    }
}
