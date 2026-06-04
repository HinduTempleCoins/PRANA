// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CrowdStaking — NutBox-style CommunityFi crowd-staking (BI11)
/// @notice Users *delegate* (stake) a shared "power" ERC-20 (e.g. a staked governance / MELEK-Power
///         token) into one of many named **community pools**. Each pool streams its own community
///         **reward token** over time, and that stream is split among the pool's delegators
///         pro-rata to their share of the pool, using the proven Sushi/PancakeSwap **MasterChef**
///         accrual pattern (`accRewardPerShare` accumulator + per-user `rewardDebt`). Communities
///         pre-fund the reward token into this contract; emissions are *transferred out* on harvest
///         (this is NOT a minter — unlike {DelegationMint}).
///
///         Reference mechanics — github.com/nutbox-dao: a delegator picks a community, delegates a
///         power token to it, and earns that community's reward token in proportion to its delegated
///         share over time. Delegation is fully withdrawable (`unstake` returns the power token) —
///         this is delegation, NOT a burn (unlike {BurnStakeRegistry}).
///
///         Accounting math (MasterChef; see Sushi `MasterChef.sol`):
///           accRewardPerShare += (elapsedBlocks * emissionPerBlock * ACC) / totalStaked
///           pending(user)      = user.amount * accRewardPerShare / ACC - user.rewardDebt
///           rewardDebt(user)   = user.amount * accRewardPerShare / ACC      (reset on every touch)
///         `ACC = 1e18` (chosen over 1e12 to minimise truncation when share counts are large and
///         emissions per block are small). Blocks with `totalStaked == 0` are skipped, never
///         back-paid. Reward payouts are capped at the contract's actual reward-token balance for
///         that token, so an under-funded pool degrades gracefully instead of reverting.
contract CrowdStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Fixed-point scale for `accRewardPerShare`. 1e18 keeps precision for small per-block
    ///      emissions divided across large total-staked supplies.
    uint256 private constant ACC = 1e18;

    /// @notice The single shared "power" token delegated across every community pool.
    IERC20 public immutable powerToken;

    struct PoolInfo {
        IERC20 rewardToken;       // this community's reward token (pre-funded into the contract)
        uint256 emissionPerBlock; // reward tokens streamed to the pool per block
        uint256 totalStaked;      // total power token delegated to this pool
        uint256 accRewardPerShare;// scaled by ACC
        uint256 lastRewardBlock;  // block accRewardPerShare was last advanced to
        bytes32 name;             // community name (e.g. "MELEK", short label as bytes32)
        bool exists;              // set true once added (distinguish a real pool from the zero slot)
    }

    struct UserInfo {
        uint256 amount;     // power token this user has delegated to the pool
        uint256 rewardDebt; // amount * accRewardPerShare / ACC at last touch
        uint256 pending;    // crystallised, not-yet-harvested reward
    }

    /// @notice All community pools, indexed by pool id (its index in this array).
    PoolInfo[] public pools;

    /// @notice Per-pool, per-user delegation state: userInfo[pid][user].
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    event PoolAdded(uint256 indexed pid, address indexed rewardToken, uint256 emissionPerBlock, bytes32 name);
    event EmissionRateChanged(uint256 indexed pid, uint256 oldRate, uint256 newRate);
    event Staked(uint256 indexed pid, address indexed user, uint256 amount, uint256 newAmount);
    event Unstaked(uint256 indexed pid, address indexed user, uint256 amount, uint256 newAmount);
    event Harvested(uint256 indexed pid, address indexed user, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error UnknownPool();
    error InsufficientStake();

    /// @param powerToken_ the shared power/governance token delegated into pools
    /// @param owner_       admin / DAO that may add pools and change emission rates
    constructor(IERC20 powerToken_, address owner_) Ownable(owner_) {
        if (address(powerToken_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        powerToken = powerToken_;
    }

    // --------------------------------------------------------------------- //
    //  Admin / DAO                                                          //
    // --------------------------------------------------------------------- //

    /// @notice Register a new community pool. The reward token must be pre-funded (transferred to
    ///         this contract) by the community out-of-band; emissions stream from that balance.
    /// @return pid the new pool's id.
    function addPool(IERC20 rewardToken_, uint256 emissionPerBlock_, bytes32 name)
        external
        onlyOwner
        returns (uint256 pid)
    {
        if (address(rewardToken_) == address(0)) revert ZeroAddress();
        if (emissionPerBlock_ == 0) revert ZeroAmount();

        pid = pools.length;
        pools.push(
            PoolInfo({
                rewardToken: rewardToken_,
                emissionPerBlock: emissionPerBlock_,
                totalStaked: 0,
                accRewardPerShare: 0,
                lastRewardBlock: block.number,
                name: name,
                exists: true
            })
        );

        emit PoolAdded(pid, address(rewardToken_), emissionPerBlock_, name);
    }

    /// @notice Change a pool's per-block emission rate (DAO knob). Settles accrual up to the current
    ///         block at the OLD rate first, so the change is not retroactive.
    function setEmissionRate(uint256 pid, uint256 emissionPerBlock_) external onlyOwner {
        PoolInfo storage p = _pool(pid);
        if (emissionPerBlock_ == 0) revert ZeroAmount();
        _updatePool(p);
        uint256 old = p.emissionPerBlock;
        p.emissionPerBlock = emissionPerBlock_;
        emit EmissionRateChanged(pid, old, emissionPerBlock_);
    }

    // --------------------------------------------------------------------- //
    //  Views                                                                //
    // --------------------------------------------------------------------- //

    /// @notice Number of community pools registered.
    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    /// @notice `accRewardPerShare` brought current to this block, without mutating state.
    function pendingAccPerShare(uint256 pid) public view returns (uint256) {
        PoolInfo storage p = _pool(pid);
        if (block.number <= p.lastRewardBlock || p.totalStaked == 0) return p.accRewardPerShare;
        uint256 blocks = block.number - p.lastRewardBlock;
        uint256 reward = blocks * p.emissionPerBlock;
        return p.accRewardPerShare + (reward * ACC) / p.totalStaked;
    }

    /// @notice Harvestable reward for `user` in pool `pid` as of the current block.
    function pendingReward(uint256 pid, address user) external view returns (uint256) {
        UserInfo storage u = userInfo[pid][user];
        uint256 acc = pendingAccPerShare(pid);
        return u.pending + (u.amount * acc) / ACC - u.rewardDebt;
    }

    /// @notice Power-token amount `user` currently has delegated to pool `pid`.
    function stakedOf(uint256 pid, address user) external view returns (uint256) {
        return userInfo[pid][user].amount;
    }

    // --------------------------------------------------------------------- //
    //  Stake / unstake / harvest                                            //
    // --------------------------------------------------------------------- //

    /// @notice Delegate `amount` of the power token into community pool `pid`.
    function stake(uint256 pid, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        PoolInfo storage p = _pool(pid);
        UserInfo storage u = userInfo[pid][msg.sender];

        _updatePool(p);
        _crystallise(p, u);

        powerToken.safeTransferFrom(msg.sender, address(this), amount);
        u.amount += amount;
        p.totalStaked += amount;
        u.rewardDebt = (u.amount * p.accRewardPerShare) / ACC;

        emit Staked(pid, msg.sender, amount, u.amount);
    }

    /// @notice Undelegate `amount` of the power token from pool `pid`; principal returns to you.
    ///         Accrued reward is preserved (crystallised) and remains harvestable.
    function unstake(uint256 pid, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        PoolInfo storage p = _pool(pid);
        UserInfo storage u = userInfo[pid][msg.sender];
        if (amount > u.amount) revert InsufficientStake();

        _updatePool(p);
        _crystallise(p, u);

        u.amount -= amount;
        p.totalStaked -= amount;
        u.rewardDebt = (u.amount * p.accRewardPerShare) / ACC;

        powerToken.safeTransfer(msg.sender, amount);

        emit Unstaked(pid, msg.sender, amount, u.amount);
    }

    /// @notice Harvest all accrued community reward from pool `pid` to the caller.
    /// @return paid the reward-token amount transferred out.
    function harvest(uint256 pid) external nonReentrant returns (uint256 paid) {
        PoolInfo storage p = _pool(pid);
        UserInfo storage u = userInfo[pid][msg.sender];

        _updatePool(p);
        _crystallise(p, u);
        u.rewardDebt = (u.amount * p.accRewardPerShare) / ACC;

        uint256 owed = u.pending;
        if (owed == 0) return 0;

        // Pay at most what the contract actually holds of this reward token: an under-funded
        // community degrades gracefully (partial payout) instead of bricking harvest for everyone.
        uint256 bal = p.rewardToken.balanceOf(address(this));
        paid = owed > bal ? bal : owed;
        u.pending = owed - paid;

        if (paid > 0) {
            p.rewardToken.safeTransfer(msg.sender, paid);
            emit Harvested(pid, msg.sender, paid);
        }
    }

    // --------------------------------------------------------------------- //
    //  Internal                                                             //
    // --------------------------------------------------------------------- //

    /// @dev Resolve a pool by id, reverting if it does not exist.
    function _pool(uint256 pid) internal view returns (PoolInfo storage p) {
        if (pid >= pools.length) revert UnknownPool();
        p = pools[pid];
        if (!p.exists) revert UnknownPool();
    }

    /// @dev Advance a pool's `accRewardPerShare` to the current block. Blocks while nothing is
    ///      staked emit nothing (skipped, not back-paid).
    function _updatePool(PoolInfo storage p) internal {
        if (block.number <= p.lastRewardBlock) return;
        if (p.totalStaked == 0) {
            p.lastRewardBlock = block.number;
            return;
        }
        uint256 blocks = block.number - p.lastRewardBlock;
        uint256 reward = blocks * p.emissionPerBlock;
        p.accRewardPerShare += (reward * ACC) / p.totalStaked;
        p.lastRewardBlock = block.number;
    }

    /// @dev Move the user's freshly-accrued reward into `pending`. Assumes the pool was just updated.
    function _crystallise(PoolInfo storage p, UserInfo storage u) internal {
        if (u.amount > 0) {
            u.pending += (u.amount * p.accRewardPerShare) / ACC - u.rewardDebt;
        }
    }
}
