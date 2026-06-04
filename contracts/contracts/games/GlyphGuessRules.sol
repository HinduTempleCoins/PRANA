// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title GlyphGuessRules — committer-vs-guesser hangman for the GameTable engine.
/// @notice A 2-player {IGameRules} implementation. Player 0 (the COMMITTER) commits a hidden
///         word as a Merkle root over its letters; player 1 (the GUESSER) guesses letters one
///         at a time. The committer must truthfully disclose every position holding a guessed
///         letter (with Merkle proofs). Fully revealing the word before running out of wrong
///         guesses wins for the guesser; reaching `maxWrong` wrong letters wins for the
///         committer. Provably inconsistent disclosures forfeit the match to the guesser.
///
/// @dev    Rules contracts are STATELESS — all match state is the opaque `bytes` blob below.
///         GameTable owns turn rotation, stakes, deadlines and settlement.
///
///         ── ALPHABET ──
///         Letters are coded 0..25 (a..z). Words are 3..16 letters.
///
///         ── MERKLE LEAF ──
///         Each position of the secret word is a leaf:
///             leaf = keccak256(bytes.concat(keccak256(abi.encode(
///                       uint8 position, uint8 letterCode, bytes32 salt))))
///         (OZ StandardMerkleTree double-hash leaf; pairs hashed sorted/commutative.) Every
///         position MUST use a fresh random `salt` so the guesser cannot brute-force letters.
///
///         ── CONFIG (to {initialState}) ──
///         abi.encode(uint8 maxWrong). Empty config ⇒ default 6. maxWrong must be 1..255.
///
///         ── MOVE ENCODING ──
///         The match alternates SETUP → (GUESS → DISCLOSE)* → optional FINAL.
///         • SETUP (committer, player 0, phase=0):
///             abi.encode(uint8 wordLength, bytes32 merkleRoot), wordLength in 3..16.
///         • GUESS (guesser, player 1, phase=1):
///             abi.encode(uint8 letterCode), 0..25, not previously guessed.
///         • DISCLOSE (committer, player 0, phase=2): the committer's response to the pending
///             guessed letter — proof that letter occupies EXACTLY the claimed positions:
///             abi.encode(Disclosure[] items) where each item is
///                 (uint8 position, uint8 letter, bytes32 salt, bytes32[] proof).
///             Every item's `letter` must equal pendingLetter and Merkle-prove
///             `keccak256(... position, letter, salt ...)`.
///             An empty array claims the letter is absent (recorded in `emptyMask`). Proving a
///             letter present after having claimed that SAME letter absent is impossible here
///             (a letter is guessed only once), so the cross-letter contradiction we catch is:
///             a position newly proven to hold the pending letter while an EARLIER disclosure
///             already proved a DIFFERENT letter at that same position ⇒ two letters in one cell
///             ⇒ fraud forfeit. After a successful disclosure the count of newly
///             revealed positions decides: ≥1 ⇒ correct guess (mask grows), 0 ⇒ wrong guess
///             (`wrong` increments). If `revealedMask` now covers all `wordLength` positions the
///             guesser wins immediately (the FINAL phase is then skipped).
///         • FINAL (committer, player 0, phase=3): only entered if the word is NOT yet fully
///             revealed but the match is otherwise decided in the committer's favor by
///             reaching maxWrong. See HONESTY LIMIT below — GameTable's deadline forces this.
///             Move: abi.encode(Disclosure[] items) covering EVERY still-unrevealed position,
///             each carrying its own `letter` (the remaining word is multi-letter). A consistent
///             full reveal confirms the committer's win; any contradiction or a missing position
///             ⇒ fraud forfeit to the guesser.
///
///         ── STATE ENCODING (opaque blob) ──
///         abi.encode(
///           uint8   maxWrong,
///           uint8   phase,        // 0 SETUP · 1 GUESS · 2 DISCLOSE · 3 FINAL
///           uint8   wordLength,
///           uint8   wrong,        // wrong-letter count so far
///           uint8   pendingLetter,// the letter awaiting disclosure (valid in phase 2)
///           bytes32 root,         // committed Merkle root
///           uint32  guessedMask,  // bit i set ⇒ letter i (0..25) has been guessed
///           uint32  emptyMask,    // bit i set ⇒ letter i was disclosed ABSENT (no positions)
///           uint16  revealedMask, // bit p set ⇒ position p has been correctly disclosed
///           uint8   result,       // 0 ongoing · 1 committer won · 2 guesser won
///           bool    fraud         // committer caught lying ⇒ guesser wins
///         )
///
/// @notice HONESTY LIMIT (documented): a committer can UNDER-disclose — reveal fewer positions
///         for a guessed letter than truly hold it. Under-disclosure is only *caught* if a later
///         disclosure proves that letter at a position the committer never accounted for, or if
///         the FINAL full reveal contradicts the running mask. The mitigation is the FINAL phase:
///         when the committer would win on `maxWrong` without the word being fully revealed, they
///         must produce a consistent reveal of EVERY remaining position; failure to do so within
///         GameTable's move deadline is a timeout-forfeit (the deadline is GameTable's job, not
///         this contract's). This bounds, but does not fully eliminate, profitable under-disclosure
///         within a single round.
contract GlyphGuessRules is IGameRules {
    uint8 private constant PH_SETUP = 0;
    uint8 private constant PH_GUESS = 1;
    uint8 private constant PH_DISCLOSE = 2;
    uint8 private constant PH_FINAL = 3;

    uint8 private constant DEFAULT_MAX_WRONG = 6;
    uint8 private constant MIN_LEN = 3;
    uint8 private constant MAX_LEN = 16;
    uint8 private constant LETTER_MAX = 25;

    error UnsupportedPlayerCount(uint8 numPlayers);
    error InvalidConfig();
    error WrongPhase(uint8 phase);
    error NotYourTurn(uint8 playerIndex);
    error GameOver();
    error BadWordLength(uint8 wordLength);
    error BadLetter(uint8 letter);
    error AlreadyGuessed(uint8 letter);
    error PositionOutOfRange(uint8 position);
    error BadProof(uint8 position);
    error DuplicatePosition(uint8 position);
    error WrongLetter(uint8 letter);

    /// @dev One disclosed position: a Merkle proof that `letter` sits at `position`. In the
    ///      DISCLOSE phase every item's `letter` must equal the pending guessed letter; in the
    ///      FINAL phase items may carry different letters (the rest of the word is multi-letter).
    struct Disclosure {
        uint8 position;
        uint8 letter;
        bytes32 salt;
        bytes32[] proof;
    }

    /// @dev Mirror of the opaque state tuple (keeps functions under the local-var budget).
    struct S {
        uint8 maxWrong;
        uint8 phase;
        uint8 wordLength;
        uint8 wrong;
        uint8 pendingLetter;
        bytes32 root;
        uint32 guessedMask;
        uint32 emptyMask;
        uint16 revealedMask;
        uint8 result;
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
        uint8 mw = DEFAULT_MAX_WRONG;
        if (config.length != 0) mw = abi.decode(config, (uint8));
        if (mw == 0) revert InvalidConfig();

        S memory s;
        s.maxWrong = mw;
        s.phase = PH_SETUP;
        return _encode(s);
    }

    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        S memory s = _decode(state);
        if (s.result != 0 || s.fraud) revert GameOver();

        if (s.phase == PH_SETUP) {
            _requirePlayer(playerIndex, 0);
            _setup(s, move);
        } else if (s.phase == PH_GUESS) {
            _requirePlayer(playerIndex, 1);
            _guess(s, move);
        } else if (s.phase == PH_DISCLOSE) {
            _requirePlayer(playerIndex, 0);
            _disclose(s, move, false);
        } else {
            _requirePlayer(playerIndex, 0);
            _disclose(s, move, true);
        }
        return _encode(s);
    }

    function status(bytes calldata state) external pure returns (uint8 s) {
        S memory st = _decode(state);
        if (st.fraud) return 2; // committer lied ⇒ guesser wins
        return st.result;
    }

    /// @notice Strictly turn-based (committer ↔ guesser alternation); not simultaneous.
    function simultaneous(bytes calldata) external pure returns (bool) {
        return false;
    }

    function gameName() external pure returns (string memory) {
        return "GlyphGuess";
    }

    function minPlayers() external pure returns (uint8) {
        return 2;
    }

    function maxPlayers() external pure returns (uint8) {
        return 2;
    }

    // --------------------------------------------------------------------- //
    //                            Phase handlers                             //
    // --------------------------------------------------------------------- //

    function _setup(S memory s, bytes calldata move) private pure {
        (uint8 wordLength, bytes32 root) = abi.decode(move, (uint8, bytes32));
        if (wordLength < MIN_LEN || wordLength > MAX_LEN) revert BadWordLength(wordLength);
        s.wordLength = wordLength;
        s.root = root;
        s.phase = PH_GUESS;
    }

    function _guess(S memory s, bytes calldata move) private pure {
        uint8 letter = abi.decode(move, (uint8));
        if (letter > LETTER_MAX) revert BadLetter(letter);
        uint32 bit = uint32(1) << letter;
        if (s.guessedMask & bit != 0) revert AlreadyGuessed(letter);
        s.guessedMask |= bit;
        s.pendingLetter = letter;
        s.phase = PH_DISCLOSE;
    }

    /// @dev Verify the committer's disclosure for `pendingLetter` (or, in FINAL, for all
    ///      remaining positions). Sets revealed bits, detects contradictions, advances the game.
    function _disclose(S memory s, bytes calldata move, bool isFinal) private pure {
        Disclosure[] memory items = abi.decode(move, (Disclosure[]));
        uint16 newlyRevealed = _verifyItems(s, items, isFinal);

        // A contradiction caught during verification ends the match (guesser wins via status()).
        if (s.fraud) return;

        if (isFinal) {
            _finalize(s, newlyRevealed);
            return;
        }

        if (newlyRevealed == 0) {
            // Letter absent: record the absent-letter claim and count a wrong guess.
            s.emptyMask |= (uint32(1) << s.pendingLetter);
            s.wrong += 1;
        }
        s.revealedMask |= newlyRevealed;

        if (_popcount16(s.revealedMask) == s.wordLength) {
            s.result = 2; // word fully revealed ⇒ guesser wins
            return;
        }
        if (s.wrong >= s.maxWrong) {
            s.phase = PH_FINAL; // committer must prove the rest (deadline enforced by table)
            return;
        }
        s.phase = PH_GUESS;
    }

    /// @dev FINAL: the disclosure must cover EVERY still-hidden position consistently. Any
    ///      gap (a position left unrevealed) or contradiction forfeits to the guesser.
    function _finalize(S memory s, uint16 newlyRevealed) private pure {
        s.revealedMask |= newlyRevealed;
        if (_popcount16(s.revealedMask) == s.wordLength) {
            s.result = 1; // full consistent reveal confirms the committer's maxWrong win
        } else {
            s.fraud = true; // missing position(s) ⇒ could not honor the secret ⇒ guesser wins
        }
    }

    // --------------------------------------------------------------------- //
    //                               Helpers                                 //
    // --------------------------------------------------------------------- //

    /// @dev Validate each disclosed position's proof against `root` for `letter`, returning a
    ///      bitmask of newly proven positions. Reverts on bad proof / range / duplicate in the
    ///      submitted batch; flags `fraud` when a position is proven that an earlier disclosure
    ///      already filled with a different letter (two letters in one cell).
    function _verifyItems(S memory s, Disclosure[] memory items, bool isFinal)
        private
        pure
        returns (uint16 newlyRevealed)
    {
        for (uint256 i = 0; i < items.length; i++) {
            uint8 pos = items[i].position;
            uint8 letter = items[i].letter;
            if (pos >= s.wordLength) revert PositionOutOfRange(pos);
            // DISCLOSE answers exactly the pending guess; FINAL may span the word's letters.
            if (!isFinal && letter != s.pendingLetter) revert WrongLetter(letter);
            uint16 pbit = uint16(1) << pos;
            if (newlyRevealed & pbit != 0) revert DuplicatePosition(pos);

            bytes32 leaf = keccak256(
                bytes.concat(keccak256(abi.encode(pos, letter, items[i].salt)))
            );
            if (!MerkleProof.verify(items[i].proof, s.root, leaf)) revert BadProof(pos);

            // Contradiction: this position already had a (different) letter proven into it by an
            // earlier disclosure — two letters cannot share one cell ⇒ committer fraud. (Letters
            // are guessed at most once, so a repeat here is always a *different* letter.)
            if (s.revealedMask & pbit != 0) {
                s.fraud = true;
            }
            newlyRevealed |= pbit;
        }
    }

    function _requirePlayer(uint8 actual, uint8 expected) private pure {
        if (actual != expected) revert NotYourTurn(actual);
    }

    /// @dev Hamming weight of a 16-bit mask (number of set position bits).
    function _popcount16(uint16 x) private pure returns (uint8 c) {
        for (uint256 i = 0; i < 16; i++) {
            if (x & (uint16(1) << i) != 0) c++;
        }
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
