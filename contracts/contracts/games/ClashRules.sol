// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @title ClashRules — commit-reveal Rock-Paper-Scissors, best-of-N.
/// @notice A 2-player IGameRules implementation for GameTable. Each round runs in two
///         simultaneous phases: a COMMIT phase (both players post a commitment hash) and a
///         REVEAL phase (both players post the preimage). A round winner scores a point;
///         first to ceil(N/2) round wins takes the match.
/// @dev    Rules contracts are STATELESS — all state is the opaque `bytes` blob below.
///
///         ── Config encoding (`config` to initialState) ──
///         abi.encode(uint8 n) where `n` is the (odd) best-of count. Empty config ⇒ default 3.
///         `n` must be odd and ≥ 1 so ceil(N/2) is a strict majority and ties cannot occur.
///
///         ── Move encoding ──
///         COMMIT phase move: abi.encode(bytes32 commitment), where the commitment a player
///           computes off-chain is keccak256(abi.encode(uint8 choice, bytes32 salt)).
///         REVEAL phase move: abi.encode(uint8 choice, bytes32 salt). The rules recompute
///           keccak256(abi.encode(choice, salt)) and compare to the stored commitment.
///           `choice` is 0=Rock, 1=Paper, 2=Scissors. A reveal is "bad" if the hash mismatches
///           or choice > 2.
///
///         ── State encoding (the opaque blob) ──
///         abi.encode(
///           uint8   n,            // best-of count (odd)
///           uint8   phase,        // 0 = COMMIT, 1 = REVEAL
///           uint8   scoreP0,      // round wins, player index 0
///           uint8   scoreP1,      // round wins, player index 1
///           bool    committed0,   // player 0 has committed this round
///           bool    committed1,   // player 1 has committed this round
///           bool    revealed0,    // player 0 has revealed this round
///           bool    revealed1,    // player 1 has revealed this round
///           bytes32 commit0,      // player 0 commitment (valid iff committed0)
///           bytes32 commit1,      // player 1 commitment (valid iff committed1)
///           uint8   choice0,      // player 0 revealed choice (valid iff revealed0)
///           uint8   choice1,      // player 1 revealed choice (valid iff revealed1)
///           bool    bad0,         // player 0 reveal was invalid (forfeits the round)
///           bool    bad1          // player 1 reveal was invalid (forfeits the round)
///         )
///
///         Phase transitions: both players commit ⇒ phase flips COMMIT→REVEAL. Both players
///         reveal ⇒ the round is scored, per-round flags reset, phase flips REVEAL→COMMIT for
///         the next round (unless the match is already decided). simultaneous() is always true.
contract ClashRules is IGameRules {
    uint8 private constant PHASE_COMMIT = 0;
    uint8 private constant PHASE_REVEAL = 1;
    uint8 private constant DEFAULT_N = 3;
    uint8 private constant CHOICE_MAX = 2; // Rock=0, Paper=1, Scissors=2

    error UnsupportedPlayerCount(uint8 numPlayers);
    error InvalidConfig();
    error WrongPhase(uint8 phase);
    error AlreadyActed(uint8 playerIndex);
    error BadPlayerIndex(uint8 playerIndex);

    /// @dev Mirror of the state tuple, used to keep functions under the local-var budget.
    struct S {
        uint8 n;
        uint8 phase;
        uint8 scoreP0;
        uint8 scoreP1;
        bool committed0;
        bool committed1;
        bool revealed0;
        bool revealed1;
        bytes32 commit0;
        bytes32 commit1;
        uint8 choice0;
        uint8 choice1;
        bool bad0;
        bool bad1;
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
        uint8 n = DEFAULT_N;
        if (config.length != 0) {
            n = abi.decode(config, (uint8));
        }
        if (n == 0 || n % 2 == 0) revert InvalidConfig();

        S memory s;
        s.n = n;
        s.phase = PHASE_COMMIT;
        return _encode(s);
    }

    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        pure
        returns (bytes memory)
    {
        if (playerIndex > 1) revert BadPlayerIndex(playerIndex);
        S memory s = _decode(state);

        if (s.phase == PHASE_COMMIT) {
            _commit(s, playerIndex, move);
        } else {
            _reveal(s, playerIndex, move);
        }
        return _encode(s);
    }

    /// @return s 0 = ongoing · 1 = player0 won · 2 = player1 won. Draw (255) is impossible
    ///           because N is odd, so a strict majority is always reached first.
    function status(bytes calldata state) external pure returns (uint8 s) {
        S memory st = _decode(state);
        uint8 target = _target(st.n);
        if (st.scoreP0 >= target) return 1;
        if (st.scoreP1 >= target) return 2;
        return 0;
    }

    /// @notice Always true: both phases (commit and reveal) take simultaneous moves.
    function simultaneous(bytes calldata) external pure returns (bool) {
        return true;
    }

    function gameName() external pure returns (string memory) {
        return "Clash";
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

    /// @dev Record a player's commitment hash. Reverts on double-commit; flips to REVEAL once
    ///      both have committed.
    function _commit(S memory s, uint8 playerIndex, bytes calldata move) private pure {
        bytes32 c = abi.decode(move, (bytes32));
        if (playerIndex == 0) {
            if (s.committed0) revert AlreadyActed(0);
            s.committed0 = true;
            s.commit0 = c;
        } else {
            if (s.committed1) revert AlreadyActed(1);
            s.committed1 = true;
            s.commit1 = c;
        }
        if (s.committed0 && s.committed1) {
            s.phase = PHASE_REVEAL;
        }
    }

    /// @dev Record a player's reveal, flagging a bad (mismatching / out-of-range) reveal as a
    ///      round forfeit. Once both have revealed, scores the round.
    function _reveal(S memory s, uint8 playerIndex, bytes calldata move) private pure {
        (uint8 choice, bytes32 salt) = abi.decode(move, (uint8, bytes32));
        if (playerIndex == 0) {
            if (s.revealed0) revert AlreadyActed(0);
            s.revealed0 = true;
            s.choice0 = choice;
            s.bad0 = choice > CHOICE_MAX || keccak256(abi.encode(choice, salt)) != s.commit0;
        } else {
            if (s.revealed1) revert AlreadyActed(1);
            s.revealed1 = true;
            s.choice1 = choice;
            s.bad1 = choice > CHOICE_MAX || keccak256(abi.encode(choice, salt)) != s.commit1;
        }
        if (s.revealed0 && s.revealed1) {
            _scoreRound(s);
        }
    }

    /// @dev Resolve the completed round, update scores, then reset per-round flags. If the
    ///      match is now decided the phase is left at COMMIT (status() reports the winner).
    function _scoreRound(S memory s) private pure {
        // Both-bad ⇒ void round (replay): award no point, just reset.
        if (!(s.bad0 && s.bad1)) {
            uint8 w = _roundWinner(s); // 0 = p0, 1 = p1, 2 = tie
            if (w == 0) {
                s.scoreP0 += 1;
            } else if (w == 1) {
                s.scoreP1 += 1;
            }
        }
        _resetRound(s);
    }

    // --------------------------------------------------------------------- //
    //                               Helpers                                 //
    // --------------------------------------------------------------------- //

    /// @dev Winner of a fully-revealed round: 0 = player0, 1 = player1, 2 = tie/void.
    ///      A single bad reveal forfeits the round to the other player.
    function _roundWinner(S memory s) private pure returns (uint8) {
        if (s.bad0) return 1; // (both-bad handled by caller)
        if (s.bad1) return 0;
        if (s.choice0 == s.choice1) return 2; // tie ⇒ void/replay
        // Standard RPS: a beats (a+2)%3 — rock(0)>scissors(2), scissors(2)>paper(1), paper(1)>rock(0).
        if ((s.choice0 + 2) % 3 == s.choice1) return 0;
        return 1;
    }

    /// @dev Strict-majority threshold: ceil(n/2).
    function _target(uint8 n) private pure returns (uint8) {
        return (n / 2) + 1;
    }

    /// @dev Clear per-round flags and re-arm the COMMIT phase for the next round.
    function _resetRound(S memory s) private pure {
        s.phase = PHASE_COMMIT;
        s.committed0 = false;
        s.committed1 = false;
        s.revealed0 = false;
        s.revealed1 = false;
        s.commit0 = bytes32(0);
        s.commit1 = bytes32(0);
        s.choice0 = 0;
        s.choice1 = 0;
        s.bad0 = false;
        s.bad1 = false;
    }

    function _encode(S memory s) private pure returns (bytes memory) {
        // Whole-struct encode: identical tuple layout, stack-light.
        return abi.encode(s);
    }

    function _decode(bytes calldata state) private pure returns (S memory s) {
        // Whole-struct decode: identical tuple layout, stack-light.
        s = abi.decode(state, (S));
    }
}