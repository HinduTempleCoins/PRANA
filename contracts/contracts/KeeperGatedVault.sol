// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PausableGuardian} from "./PausableGuardian.sol";

/// @title KeeperGatedVault — the DeFAI guardrail
/// @notice A vault that holds ERC-20s and lets a semi-trusted automated KEEPER (e.g. an AI agent)
///         execute arbitrary calls to OTHER protocols — but only inside hard, owner-set rails:
///           1. ALLOWLIST: the (target contract, 4-byte selector) pair must be explicitly enabled.
///           2. PER-TX CAP: any single call may move at most `maxSingleSpend[token]` of a token out.
///           3. PER-EPOCH CAP: cumulative outflow of a token within a fixed time window is capped.
///           4. PAPER-TRADE: a global mode where `execute` performs NO external call and only emits
///              `ProposedAction` for off-chain (human/sim) review — dry-run the agent safely.
///           5. EMERGENCY PAUSE: owner/guardian can freeze all execution via PausableGuardian.
///
///         Outflow is METERED BY BALANCE DELTA: the vault snapshots the balance of every
///         caller-declared `meteredTokens` token before the call and re-reads after; the drop is
///         the realized outflow charged against the caps. This catches outflow regardless of which
///         function/path the target used to pull funds (approvals, transfers, swaps), so a hijacked
///         keyholder cannot exceed the budget even by routing through an allowed-but-leaky target.
///
///         Trust model: the keeper is trusted for INTENT but not for AMOUNT or DESTINATION class —
///         the rails bound the blast radius. The owner is fully trusted (sets rails, withdraws).
contract KeeperGatedVault is PausableGuardian {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice Epoch window length (seconds) for the rolling per-token outflow cap.
    uint256 public immutable epochLength;

    /// @notice When true, `execute` makes NO external call; it only emits ProposedAction.
    bool public paperTrade;

    /// @notice (target, selector) => allowed.
    mapping(address => mapping(bytes4 => bool)) public allowed;
    /// @notice token => max outflow permitted in a single execute call.
    mapping(address => uint256) public maxSingleSpend;
    /// @notice token => max cumulative outflow permitted per epoch.
    mapping(address => uint256) public epochCap;
    /// @notice token => epoch index => outflow charged that epoch.
    mapping(address => mapping(uint256 => uint256)) public spentInEpoch;

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

    error ZeroAddress();
    error ZeroValue();
    error NotAllowed(address target, bytes4 selector);
    error CalldataTooShort();
    error SingleSpendExceeded(address token, uint256 outflow, uint256 cap);
    error EpochCapExceeded(address token, uint256 outflow, uint256 remaining);
    error CallFailed();

    /// @param owner        DEFAULT_ADMIN_ROLE + GUARDIAN_ROLE (via PausableGuardian).
    /// @param keeper       initial KEEPER_ROLE holder (the automated executor).
    /// @param unpauseDelay timelock seconds for the guarded unpause flow.
    /// @param epochLength_ rolling window for the per-token epoch cap.
    /// @param paperTrade_  start in paper-trade (dry-run) mode if true.
    constructor(
        address owner,
        address keeper,
        uint256 unpauseDelay,
        uint256 epochLength_,
        bool paperTrade_
    ) PausableGuardian(unpauseDelay, owner) {
        if (owner == address(0) || keeper == address(0)) revert ZeroAddress();
        if (epochLength_ == 0) revert ZeroValue();
        epochLength = epochLength_;
        paperTrade = paperTrade_;
        _grantRole(KEEPER_ROLE, keeper);
        emit KeeperSet(keeper, true);
        emit PaperTradeSet(paperTrade_);
    }

    // --------------------------------------------------------------------- //
    //                              Owner config                             //
    // --------------------------------------------------------------------- //

    function setAllowed(address target, bytes4 selector, bool ok) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        allowed[target][selector] = ok;
        emit TargetAllowed(target, selector, ok);
    }

    function setMaxSingleSpend(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        maxSingleSpend[token] = amount;
        emit MaxSingleSpendSet(token, amount);
    }

    function setEpochCap(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        epochCap[token] = amount;
        emit EpochCapSet(token, amount);
    }

    function setPaperTrade(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        paperTrade = enabled;
        emit PaperTradeSet(enabled);
    }

    function setKeeper(address keeper, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (keeper == address(0)) revert ZeroAddress();
        if (enabled) _grantRole(KEEPER_ROLE, keeper);
        else _revokeRole(KEEPER_ROLE, keeper);
        emit KeeperSet(keeper, enabled);
    }

    /// @notice Owner withdraws assets out of the vault directly (not metered — owner is trusted).
    function withdraw(IERC20 token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }

    // --------------------------------------------------------------------- //
    //                                Deposit                                //
    // --------------------------------------------------------------------- //

    function deposit(IERC20 token, uint256 amount) external {
        if (amount == 0) revert ZeroValue();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(address(token), msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    //                                Execute                                //
    // --------------------------------------------------------------------- //

    /// @notice Current epoch index for the rolling per-token cap.
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLength;
    }

    /// @notice Keeper-driven call into an allowlisted target, metered against the caps.
    /// @param target        contract to call (must be allowlisted for `data`'s selector)
    /// @param data          full calldata (first 4 bytes = selector)
    /// @param value         native value to forward
    /// @param meteredTokens tokens whose balance delta is charged against the caps. The keeper
    ///                      declares which tokens the call could move; any of these that drop are
    ///                      metered. (Tokens omitted here are not charged — owner allowlists only
    ///                      targets that move known tokens, so the declared set is auditable.)
    function execute(
        address target,
        bytes calldata data,
        uint256 value,
        address[] calldata meteredTokens
    ) external onlyRole(KEEPER_ROLE) whenNotPaused {
        if (target == address(0)) revert ZeroAddress();
        if (data.length < 4) revert CalldataTooShort();
        bytes4 selector = bytes4(data[:4]);
        if (!allowed[target][selector]) revert NotAllowed(target, selector);

        // Paper-trade: never touch the outside world; just record the intent for review.
        if (paperTrade) {
            emit ProposedAction(msg.sender, target, selector, data, value);
            return;
        }

        uint256[] memory before = _snapshot(meteredTokens);
        _doCall(target, data, value);
        _meterOutflows(meteredTokens, before);

        emit Executed(msg.sender, target, selector, value);
    }

    /// @dev Snapshot this vault's balance of each metered token before the call.
    function _snapshot(address[] calldata tokens) private view returns (uint256[] memory bals) {
        bals = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            bals[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
    }

    /// @dev Perform the external call, bubbling failure as a clean custom error.
    function _doCall(address target, bytes calldata data, uint256 value) private {
        (bool ok, ) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
    }

    /// @dev For each metered token, charge the realized outflow (pre - post) against both caps.
    function _meterOutflows(address[] calldata tokens, uint256[] memory before) private {
        uint256 epoch = currentEpoch();
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 post = IERC20(token).balanceOf(address(this));
            if (post >= before[i]) continue; // inflow or unchanged: not an outflow
            uint256 outflow = before[i] - post;
            _chargeToken(token, epoch, outflow);
        }
    }

    /// @dev Enforce per-tx and per-epoch caps for a single token's outflow and record the spend.
    function _chargeToken(address token, uint256 epoch, uint256 outflow) private {
        uint256 single = maxSingleSpend[token];
        if (outflow > single) revert SingleSpendExceeded(token, outflow, single);

        uint256 spent = spentInEpoch[token][epoch];
        uint256 cap = epochCap[token];
        if (spent + outflow > cap) revert EpochCapExceeded(token, outflow, cap - spent);

        uint256 newSpent = spent + outflow;
        spentInEpoch[token][epoch] = newSpent;
        emit Outflow(token, outflow, epoch, newSpent);
    }

    /// @notice Remaining epoch outflow budget for a token.
    function remainingEpochBudget(address token) external view returns (uint256) {
        uint256 spent = spentInEpoch[token][currentEpoch()];
        uint256 cap = epochCap[token];
        return spent >= cap ? 0 : cap - spent;
    }

    receive() external payable {}
}
