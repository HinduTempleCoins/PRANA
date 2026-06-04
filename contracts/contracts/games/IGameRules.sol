// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IGameRules — the pluggable rules interface every GameTable board game implements.
/// @notice GameTable (the shared engine) owns matchmaking, stakes, turn order, deadlines and
///         settlement; a rules contract owns ONLY the game logic. State and moves are opaque
///         `bytes` so each game picks its own encoding (document it in the rules contract).
///         Rules contracts MUST be stateless (pure/view) — all match state lives in GameTable.
/// @dev Commit-reveal games (e.g. simultaneous-move or hidden-information games) encode the
///      commit/reveal phases inside their state machine: a "move" during the commit phase is
///      the commitment hash; during the reveal phase it is the preimage. The rules contract
///      enforces phase ordering and can signal a fraud-forfeit via status().
interface IGameRules {
    /// @notice Build the initial state for a new match.
    /// @param config Game-specific setup parameters (board size, heap counts, …); may be empty.
    /// @param numPlayers Player count the table matched (rules revert if unsupported).
    function initialState(bytes calldata config, uint8 numPlayers)
        external
        view
        returns (bytes memory state);

    /// @notice Apply `move` by the player at `playerIndex` to `state`.
    /// @dev MUST revert on any illegal move (wrong phase, out of bounds, not your decision…).
    ///      GameTable has already enforced that it IS this player's turn (or, for simultaneous
    ///      phases signaled via `simultaneous()`, that the player has not yet acted this round).
    function applyMove(bytes calldata state, uint8 playerIndex, bytes calldata move)
        external
        view
        returns (bytes memory newState);

    /// @notice Terminal status of a state.
    /// @return s 0 = ongoing · 1..numPlayers = that player (1-based) won · 255 = draw.
    function status(bytes calldata state) external view returns (uint8 s);

    /// @notice Whether the CURRENT phase of `state` takes simultaneous (commit/reveal-style)
    ///         moves instead of strict turn alternation. Turn-based games return false always.
    function simultaneous(bytes calldata state) external view returns (bool);

    /// @notice Human/indexer metadata.
    function gameName() external pure returns (string memory);
    function minPlayers() external pure returns (uint8);
    function maxPlayers() external pure returns (uint8);
}
