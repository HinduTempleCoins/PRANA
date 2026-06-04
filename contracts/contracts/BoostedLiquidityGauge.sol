// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVoteEscrow} from "./interfaces/IVoteEscrow.sol";
import {VeBoost} from "./lib/VeBoost.sol";

/// @title BoostedLiquidityGauge — Synthetix reward stream weighted by Curve ve-boost
/// @notice Same linear stake×time reward accrual as {LiquidityGauge}, but each depositor accrues
///         against their *working balance* (Curve boost) instead of their raw deposit. Holding
///         vote-escrow (ve) weight boosts your effective stake up to 2.5x; unboosted you keep the
///         1x (0.4*deposit) floor. The reward distributor funds the stream via `notifyRewardAmount`.
/// @dev Differences from the plain gauge that matter:
///      1. Accrual divides by `totalWorkingSupply` (sum of working balances), and a user earns on
///         their stored `workingBalanceOf` — refreshed on every stake/withdraw/claim and on `kick`.
///      2. Fee-on-transfer safety: deposits are credited from the *actual* received amount
///         (balanceOf delta), never the requested amount, so a deflationary stake token cannot
///         over-credit a depositor. The plain gauge credits the requested amount — a known finding.
contract BoostedLiquidityGauge {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    IVoteEscrow public immutable ve;
    address public immutable rewardDistributor;
    uint256 private constant ACC = 1e18;

    uint256 public rewardRate;          // reward tokens per second
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;

    /// @notice Sum of raw deposited stake (what users can withdraw).
    uint256 public totalSupply;
    /// @notice Sum of boosted working balances (the accrual denominator).
    uint256 public totalWorkingSupply;

    /// @notice Raw deposited stake per user (withdrawable principal).
    mapping(address => uint256) public balanceOf;
    /// @notice Boosted working balance per user (the accrual weight).
    mapping(address => uint256) public workingBalanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    error ZeroAmount();
    error BadAmount();
    error NotDistributor();
    error BadParams();
    error NothingToKick();

    event Staked(address indexed user, uint256 amount, uint256 received);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event RewardAdded(uint256 amount, uint256 duration);
    event WorkingBalanceUpdated(address indexed user, uint256 workingBalance, uint256 totalWorkingSupply);
    event Kicked(address indexed user, address indexed by, uint256 newWorkingBalance);

    constructor(IERC20 stakeToken_, IERC20 rewardToken_, IVoteEscrow ve_, address rewardDistributor_) {
        require(address(stakeToken_) != address(0) && address(rewardToken_) != address(0), "zero");
        require(address(ve_) != address(0), "ve=0");
        require(rewardDistributor_ != address(0), "distributor=0");
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        ve = ve_;
        rewardDistributor = rewardDistributor_;
    }

    // ----------------------------------------------------------------------------------
    // Reward accounting (Synthetix), but over working balances
    // ----------------------------------------------------------------------------------

    /// @dev Settle global reward-per-token and the account's pending rewards. Mirrors the plain
    ///      gauge; the only change is `rewardPerToken()` divides by `totalWorkingSupply`.
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdate = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalWorkingSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdate) * rewardRate * ACC) / totalWorkingSupply;
    }

    /// @notice Pending rewards for `account`, accrued on its working balance.
    function earned(address account) public view returns (uint256) {
        return (workingBalanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / ACC + rewards[account];
    }

    // ----------------------------------------------------------------------------------
    // Working-balance refresh (the boost)
    // ----------------------------------------------------------------------------------

    /// @dev Recompute `user`'s working balance from their raw deposit and current ve weight, and
    ///      fold the delta into `totalWorkingSupply`. MUST be called *after* `updateReward(user)`
    ///      has settled rewards at the old working balance, so the new weight only affects future
    ///      accrual. Reads ve at call time, so an expired lock naturally drops the boost on the
    ///      next refresh (stake/withdraw/claim) or via {kick}.
    function _updateWorkingBalance(address user) internal returns (uint256 newWB) {
        uint256 deposit = balanceOf[user];
        uint256 oldWB = workingBalanceOf[user];

        if (deposit == 0) {
            newWB = 0;
        } else {
            uint256 userVe = ve.balanceOf(user);
            uint256 totalVe = _totalVe();
            newWB = VeBoost.computeWorkingBalance(deposit, totalSupply, userVe, totalVe);
        }

        if (newWB != oldWB) {
            totalWorkingSupply = totalWorkingSupply - oldWB + newWB;
            workingBalanceOf[user] = newWB;
        }
        emit WorkingBalanceUpdated(user, newWB, totalWorkingSupply);
    }

    /// @dev Total ve weight used as the boost denominator. The simplified {VoteEscrow} exposes
    ///      `totalLocked` (sum of locked principal) but not a live sum of *decaying* weights; using
    ///      `totalLocked` as the denominator is a deliberate, conservative simplification: it is an
    ///      upper bound on the sum of live weights, so individual boosts are if anything understated
    ///      (never over-boosted). This keeps the gauge solvent and matches the library's rounding
    ///      direction. If a richer ve later exposes `totalWeight()`, swap it in here.
    function _totalVe() internal view returns (uint256) {
        return ve.totalLocked();
    }

    // ----------------------------------------------------------------------------------
    // User actions — each refreshes the caller's working balance
    // ----------------------------------------------------------------------------------

    /// @notice Stake `amount` of the stake token; credits the *actually received* amount.
    /// @dev Fee-on-transfer safe: we measure `balanceOf(this)` before/after the pull and credit the
    ///      delta, so a deflationary token cannot over-credit the depositor's principal.
    function stake(uint256 amount) external updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        uint256 balBefore = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakeToken.balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        totalSupply += received;
        balanceOf[msg.sender] += received;
        _updateWorkingBalance(msg.sender);
        emit Staked(msg.sender, amount, received);
    }

    /// @notice Withdraw `amount` of raw staked principal.
    function withdraw(uint256 amount) external updateReward(msg.sender) {
        if (amount == 0 || balanceOf[msg.sender] < amount) revert BadAmount();
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        _updateWorkingBalance(msg.sender);
        stakeToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Claim accrued rewards; also refreshes the caller's boost.
    function getReward() external updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
        _updateWorkingBalance(msg.sender);
    }

    /// @notice Permissionlessly recompute `user`'s working balance. Anyone may call this to remove
    ///         a stale boost once the user's ve lock has decayed/expired below what their stored
    ///         working balance assumes — the same "kick" Curve uses to keep accrual honest.
    /// @dev Reverts if the recompute would not lower the working balance, so kicking can only ever
    ///      *remove* an over-boost, never grant one (callers cannot use it to boost a third party).
    function kick(address user) external updateReward(user) {
        uint256 oldWB = workingBalanceOf[user];
        // Compute what the working balance *should* be now.
        uint256 deposit = balanceOf[user];
        uint256 shouldBe = deposit == 0
            ? 0
            : VeBoost.computeWorkingBalance(deposit, totalSupply, ve.balanceOf(user), _totalVe());
        if (shouldBe >= oldWB) revert NothingToKick();
        uint256 newWB = _updateWorkingBalance(user);
        emit Kicked(user, msg.sender, newWB);
    }

    // ----------------------------------------------------------------------------------
    // Funding
    // ----------------------------------------------------------------------------------

    /// @notice Fund `reward` tokens to stream over `duration` seconds (distributor only).
    function notifyRewardAmount(uint256 reward, uint256 duration) external updateReward(address(0)) {
        if (msg.sender != rewardDistributor) revert NotDistributor();
        if (duration == 0 || reward == 0) revert BadParams();
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / duration;
        } else {
            uint256 remaining = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + remaining) / duration;
        }
        rewardToken.safeTransferFrom(msg.sender, address(this), reward);
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(reward, duration);
    }
}
