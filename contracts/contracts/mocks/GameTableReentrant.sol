// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IGameRules} from "../games/IGameRules.sol";

/// @notice Test-only malicious player for GameTable's native-settlement path.
/// @dev ReentrantAttacker (the general-purpose mock) cannot forward `msg.value`, so it
///      cannot stake into a payable game. This focused mock can: it stakes via
///      {createMatch}/{joinMatch} carrying value, and on receiving its winnings it tries to
///      re-enter {submitMove}. The re-entry MUST fail because GameTable's money paths are
///      `nonReentrant`; `reenterSucceeded` records the outcome for the test to assert on.
interface IGameTableLike {
    function createMatch(
        IGameRules rules,
        bytes calldata config,
        address stakeToken,
        uint96 stakeAmount,
        uint8 maxPlayers,
        uint64 moveTimeout
    ) external payable returns (uint256);

    function joinMatch(uint256 id) external payable;

    function submitMove(uint256 id, bytes calldata move) external;
}

contract GameTableReentrant {
    IGameTableLike public immutable table;

    bool public armed;
    uint256 public matchId;
    bytes public reenterMove;
    bool public reenterAttempted;
    bool public reenterSucceeded;

    constructor(IGameTableLike table_) {
        table = table_;
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // one-shot, avoid recursion
        reenterAttempted = true;
        try table.submitMove(matchId, reenterMove) {
            reenterSucceeded = true;
        } catch {
            reenterSucceeded = false;
        }
    }

    function create(
        IGameRules rules,
        bytes calldata config,
        uint96 stakeAmount,
        uint8 maxPlayers,
        uint64 moveTimeout
    ) external payable returns (uint256 id) {
        id = table.createMatch{value: msg.value}(
            rules, config, address(0), stakeAmount, maxPlayers, moveTimeout
        );
    }

    function join(uint256 id) external payable {
        table.joinMatch{value: msg.value}(id);
    }

    function play(uint256 id, bytes calldata move) external {
        table.submitMove(id, move);
    }

    /// @notice Arm the re-entry: on the next native payout, attempt `move` on `id`.
    function arm(uint256 id, bytes calldata move) external {
        armed = true;
        matchId = id;
        reenterMove = move;
    }
}
