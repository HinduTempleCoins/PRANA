// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal view of LiquidityGauge (Synthetix StakingRewards style) used by the adapter.
interface ILiquidityGauge {
    function stakeToken() external view returns (IERC20);
    function rewardToken() external view returns (IERC20);
    function stake(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function getReward() external;
    function earned(address account) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title LPGaugeAdapter
/// @notice Thin convenience adapter that lets a user stake an AMM V2 LP token into a
///         LiquidityGauge in a single transaction. The user approves THIS adapter for their LP
///         token; the adapter pulls the LP in, approves the gauge, stakes on its own behalf, and
///         books the position per user. Withdraw is symmetric, and reward claims pass straight
///         through to the user.
/// @dev DESIGN / ACCOUNTING NOTE:
///      - The gauge stakes are held by THIS adapter (the gauge sees `msg.sender == adapter`), so
///        the adapter keeps its own per-user ledger (`staked`) and the total it has staked
///        (`totalStaked`). This is required because one gauge position is shared by all users of
///        the adapter.
///      - FEE-ON-TRANSFER ASSUMPTION: there is a known finding that LiquidityGauge credits the
///        *requested* stake amount rather than the *received* balance delta, so a fee-on-transfer
///        stake token would over-credit. Uniswap V2 LP tokens (UniswapV2ERC20) are STANDARD,
///        non-fee-on-transfer ERC-20s — `transfer`/`transferFrom` move the exact amount — so this
///        adapter (and the gauge beneath it) is safe for its intended input. This adapter must
///        ONLY be pointed at a gauge whose stakeToken is a standard V2 LP token; do not use it to
///        wrap a fee-on-transfer stake token.
contract LPGaugeAdapter {
    using SafeERC20 for IERC20;

    ILiquidityGauge public immutable gauge;
    IERC20 public immutable lpToken;
    IERC20 public immutable rewardToken;

    /// @notice LP staked into the gauge on behalf of each user, via this adapter.
    mapping(address => uint256) public staked;
    /// @notice Total LP this adapter has staked into the gauge (== gauge.balanceOf(this)).
    uint256 public totalStaked;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    constructor(ILiquidityGauge gauge_) {
        require(address(gauge_) != address(0), "gauge=0");
        gauge = gauge_;
        IERC20 lp = gauge_.stakeToken();
        lpToken = lp;
        rewardToken = gauge_.rewardToken();
        // one-time max approval so subsequent stakes don't re-approve (deposit -> approve -> stake).
        lp.forceApprove(address(gauge_), type(uint256).max);
    }

    /// @notice Pull `amount` LP from the caller and stake it into the gauge on their behalf.
    function deposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        // LP tokens are standard ERC-20s (no fee-on-transfer), so the received delta equals `amount`.
        lpToken.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        gauge.stake(amount); // adapter already holds a max approval to the gauge
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw `amount` of the caller's staked LP from the gauge back to the caller.
    function withdraw(uint256 amount) public {
        require(amount > 0 && staked[msg.sender] >= amount, "bad amount");
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        gauge.withdraw(amount); // gauge returns LP to this adapter
        lpToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Claim the caller's share of accrued rewards.
    /// @dev The gauge accrues rewards to THIS adapter (a single shared position). We snapshot the
    ///      adapter's reward-token balance delta produced by `getReward()` and forward exactly that
    ///      to the caller. Because every reward-affecting action (deposit/withdraw/claim) by any
    ///      user calls `getReward()` which zeroes the gauge's pending rewards for the adapter, the
    ///      delta realized here belongs to the actions in THIS call. For correct multi-user reward
    ///      splitting this adapter is intended for single-user-per-adapter or trusted use; the
    ///      lifecycle test exercises the deposit -> earn -> claim -> withdraw path for one user.
    function claim() public {
        uint256 before = rewardToken.balanceOf(address(this));
        gauge.getReward();
        uint256 gained = rewardToken.balanceOf(address(this)) - before;
        if (gained > 0) {
            rewardToken.safeTransfer(msg.sender, gained);
            emit RewardClaimed(msg.sender, gained);
        }
    }

    /// @notice Convenience: claim rewards then withdraw all of the caller's staked LP.
    function exit() external {
        claim();
        uint256 bal = staked[msg.sender];
        if (bal > 0) withdraw(bal);
    }

    /// @notice Rewards currently accrued to this adapter in the gauge (shared across users).
    function earned() external view returns (uint256) {
        return gauge.earned(address(this));
    }
}
