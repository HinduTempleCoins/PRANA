// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IKeeperGatedVault — a treasury a KEEPER may operate only through an allowlist of
///         (target, selector) calls, under per-token single-spend and rolling epoch caps.
/// @notice External surface of {KeeperGatedVault}: admins fund/withdraw and configure the
///         allowlist, spend caps and paper-trade mode; a keeper executes pre-approved calls with
///         metered token outflow. In paper-trade mode {execute} makes NO external call and only
///         emits {ProposedAction} for off-chain simulation.
interface IKeeperGatedVault {
    event TargetAllowed(address indexed target, bytes4 indexed selector, bool allowed);
    event MaxSingleSpendSet(address indexed token, uint256 amount);
    event EpochCapSet(address indexed token, uint256 amount);
    event PaperTradeSet(bool enabled);
    event KeeperSet(address indexed keeper, bool enabled);
    event ProposedAction(address indexed keeper, address indexed target, bytes4 indexed selector, bytes data, uint256 value);
    event Executed(address indexed keeper, address indexed target, bytes4 indexed selector, uint256 value);
    event Outflow(address indexed token, uint256 amount, uint256 epoch, uint256 spentThisEpoch);
    event Deposited(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    function epochLength() external view returns (uint256);
    function paperTrade() external view returns (bool);
    function allowed(address target, bytes4 selector) external view returns (bool);
    function maxSingleSpend(address token) external view returns (uint256);
    function epochCap(address token) external view returns (uint256);
    function spentInEpoch(address token, uint256 epoch) external view returns (uint256);

    // --- admin ------------------------------------------------------------ //
    function setAllowed(address target, bytes4 selector, bool ok) external;
    function setMaxSingleSpend(address token, uint256 amount) external;
    function setEpochCap(address token, uint256 amount) external;
    function setPaperTrade(bool enabled) external;
    function setKeeper(address keeper, bool enabled) external;
    function withdraw(IERC20 token, address to, uint256 amount) external;

    // --- public / keeper -------------------------------------------------- //
    function deposit(IERC20 token, uint256 amount) external;
    function execute(
        address target,
        bytes calldata data,
        uint256 value,
        address[] calldata meteredTokens
    ) external;

    // --- views ------------------------------------------------------------ //
    function currentEpoch() external view returns (uint256);
    function remainingEpochBudget(address token) external view returns (uint256);
}
