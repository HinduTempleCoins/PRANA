// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title OracleDrawRules — committer-vs-guesser hi-lo over a committed 52-card deck.
/// @notice A 2-player {IGameRules} implementation. Player 0 (the DEALER) commits a full 52-card
///         deck as a Merkle root; player 1 (the GUESSER) plays hi-lo: each round the dealer
///         reveals the next committed card, the guesser predicts whether the FOLLOWING card is
///         higher or lower in rank. A correct call scores the guesser, a wrong call scores the
///         dealer; equal rank pushes (no score change). After N rounds the higher score wins.
///         Revealing the same card value twice forfeits the match to the guesser (a committed
///         deck has 52 distinct cards).
///
/// @dev    Rules contracts are STATELESS — all match state lives in the opaque `bytes` blob.
///         GameTable owns turn rotation, stakes, deadlines and settlement.
///
///         ── CLOSED-CURRENCY / GAMBLING NOTE ──
///         This is a hi-lo guessing game whose odds are fully disclosed (rank-only, ties push).
///         Per the project brief it is intended for CLOSED / in-game ("game currency") stakes
///         only, not open-currency wagering. The fairness guardrail is the commit-reveal deck
///         (the dealer cannot adapt the deck after seeing calls) plus the duplicate-card fraud
///         check; stake symmetry and any jurisdictional gambling flags are GameTable's concern.
///
///         ── CARD ENCODING ──
///         A card is 0..51. rank = card % 13 (0=lowest .. 12=highest); suit = card / 13 is
///         ignored by the rules (rank-only hi-lo). "Same card value twice" means the same 0..51
///         code revealed in two rounds (tracked in a 52-bit seen bitmap).
///
///         ── MERKLE LEAF ──
///             leaf = keccak256(bytes.concat(keccak256(abi.encode(
///                       uint8 index, uint8 card, bytes32 salt))))
///         `index` is the deck position 0..51; each card uses a fresh random `salt`.
///
///         ── CONFIG (to {initialState}) ──
///         abi.encode(uint8 rounds). Empty config ⇒ default 13. rounds must be 1..51 (each round
///         consumes one fresh reveal beyond the priming reveal ⇒ needs rounds+1 ≤ 52 cards).
///
///         ── MOVE ENCODING ──  match flow: SETUP → PRIME → (CALL → REVEAL)*
///         • SETUP (dealer, player 0, phase=0): abi.encode(bytes32 merkleRoot).
///         • PRIME (dealer, player 0, phase=1): reveal the first face-up card —
///             abi.encode(uint8 index, uint8 card, bytes32 salt, bytes32[] proof).
///         • CALL (guesser, player 1, phase=2): abi.encode(bool higher) — true = "next is
///             higher", false = "next is lower".
///         • REVEAL (dealer, player 0, phase=3): reveal the next card and score the pending call
///             against it — abi.encode(uint8 index, uint8 card, bytes32 salt, bytes32[] proof).
///             The newly revealed card becomes the face-up card for the following round.
///
///         ── STATE ENCODING (opaque blob) ──
///         abi.encode(
///           uint8   rounds,       // total scoring rounds
///           uint8   phase,        // 0 SETUP · 1 PRIME · 2 CALL · 3 REVEAL
///           uint8   played,       // scoring rounds completed
///           uint8   faceCard,     // current face-up card 0..51 (valid once primed)
///           uint8   scoreG,       // guesser score
///           uint8   scoreD,       // dealer score
///           bool    pendingHigher,// the guesser's pending call (valid in phase 3)
///           bytes32 root,         // committed deck Merkle root
///           uint64  seenLo,       // bits 0..51: card already revealed (52-bit bitmap)
///           bool    fraud         // duplicate card revealed ⇒ dealer fraud ⇒ guesser wins
///         )
contract OracleDrawRules is IGameRules {
    uint8 private constant PH_SETUP = 0;
    uint8 private constant PH_PRIME = 1;
    uint8 private constant PH_CALL = 2;
    uint8 private constant PH_REVEAL = 3;

    uint8 private constant DEFAULT_ROUNDS = 13;
    uint8 private constant CARD_MAX = 51;
    uint8 private constant RANKS = 13;

    error UnsupportedPlayerCount(uint8 numPlayers);
    error InvalidConfig();
    error NotYourTurn(uint8 playerIndex);
    error GameOver();
    error BadCard(uint8 card);
    error BadIndex(uint8 index);
    error BadProof(uint8 index);

    /// @dev Mirror of the opaque state tuple (keeps functions under the local-var budget).
    struct S {
        uint8 rounds;
        uint8 phase;
        uint8 played;
        uint8 faceCard;
        uint8 scoreG;
        uint8 scoreD;
        bool pendingHigher;
        bytes32 root;
        uint64 seen;
        bool fraud;
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
        uint8 r = DEFAULT_ROUNDS;
        if (config.length != 0) r = abi.decode(config, (uint8));
        // Need one priming reveal plus one reveal per round, all distinct ⇒ rounds + 1 ≤ 52.
        if (r == 0 || r > CARD_MAX) revert InvalidConfig();

        S memory s;
        s.rounds = r;
        s.phase = PH_SETUP;
        return _encode(s);
    }

    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        S memory s = _decode(state);
        if (s.fraud || _decided(s)) revert GameOver();

        if (s.phase == PH_SETUP) {
            _requirePlayer(playerIndex, 0);
            s.root = abi.decode(move, (bytes32));
            s.phase = PH_PRIME;
        } else if (s.phase == PH_PRIME) {
            _requirePlayer(playerIndex, 0);
            _reveal(s, move, true);
        } else if (s.phase == PH_CALL) {
            _requirePlayer(playerIndex, 1);
            s.pendingHigher = abi.decode(move, (bool));
            s.phase = PH_REVEAL;
        } else {
            _requirePlayer(playerIndex, 0);
            _reveal(s, move, false);
        }
        return _encode(s);
    }

    /// @return s 0 = ongoing · 1 = dealer (player0) won · 2 = guesser (player1) won ·
    ///           255 = draw (equal scores after all rounds).
    function status(bytes calldata state) external pure returns (uint8 s) {
        S memory st = _decode(state);
        if (st.fraud) return 2; // dealer revealed a duplicate ⇒ guesser wins
        if (!_decided(st)) return 0;
        if (st.scoreG > st.scoreD) return 2;
        if (st.scoreD > st.scoreG) return 1;
        return 255;
    }

    /// @notice Strictly turn-based (dealer ↔ guesser alternation); not simultaneous.
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "OracleDraw";
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

    /// @dev Verify a card reveal against the committed root, enforce the no-duplicate rule, and
    ///      (when not the priming reveal) score the guesser's pending hi-lo call against it.
    function _reveal(S memory s, bytes calldata move, bool priming) private pure {
        (uint8 index, uint8 card, bytes32 salt, bytes32[] memory proof) =
            abi.decode(move, (uint8, uint8, bytes32, bytes32[]));
        if (index > CARD_MAX) revert BadIndex(index);
        if (card > CARD_MAX) revert BadCard(card);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, card, salt))));
        if (!MerkleProof.verify(proof, s.root, leaf)) revert BadProof(index);

        uint64 bit = uint64(1) << card;
        if (s.seen & bit != 0) {
            s.fraud = true; // same card value revealed twice ⇒ dealer fraud
            return;
        }
        s.seen |= bit;

        if (priming) {
            s.faceCard = card;
            s.phase = PH_CALL;
            return;
        }
        _score(s, card);
    }

    /// @dev Score the pending call comparing `next` rank to the face-up card's rank, advance the
    ///      face-up card, and either start the next round or leave the match decided.
    function _score(S memory s, uint8 next) private pure {
        uint8 prevRank = s.faceCard % RANKS;
        uint8 nextRank = next % RANKS;

        if (nextRank != prevRank) {
            bool wentHigher = nextRank > prevRank;
            if (wentHigher == s.pendingHigher) {
                s.scoreG += 1;
            } else {
                s.scoreD += 1;
            }
        }
        // Equal rank ⇒ push: no score change.

        s.faceCard = next;
        s.played += 1;
        s.phase = _decided(s) ? PH_REVEAL : PH_CALL; // phase ignored once decided
    }

    function _decided(S memory s) private pure returns (bool) {
        return s.played >= s.rounds;
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
