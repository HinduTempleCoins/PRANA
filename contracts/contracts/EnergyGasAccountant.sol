// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EnergyGasAccountant — the Prana (staked regenerating energy) gas model
/// @notice Stake the native/utility token → receive a regenerating "energy" budget proportional to
///         your stake, up to a cap; spend energy to perform actions (transactions feel "free").
///         The anti-TRON-footgun design: `energyOf` and `regenRatePerSecond` are public so a wallet
///         can SHOW the balance and refill rate. (TRON Energy / STEEM Resource Credits / EtherZero Power.)
contract EnergyGasAccountant {
    using SafeERC20 for IERC20;
    uint256 private constant ACC = 1e18;

    IERC20 public immutable stakeToken;
    uint256 public immutable energyPerStakePerSecond; // regen, scaled by ACC
    uint256 public immutable maxEnergyPerStake;        // cap, scaled by ACC

    struct Account { uint256 staked; uint256 energy; uint64 last; }
    mapping(address => Account) public accounts;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Spent(address indexed user, uint256 amount);

    constructor(IERC20 stakeToken_, uint256 energyPerStakePerSecond_, uint256 maxEnergyPerStake_) {
        require(address(stakeToken_) != address(0), "token=0");
        require(energyPerStakePerSecond_ > 0 && maxEnergyPerStake_ > 0, "bad params");
        stakeToken = stakeToken_;
        energyPerStakePerSecond = energyPerStakePerSecond_;
        maxEnergyPerStake = maxEnergyPerStake_;
    }

    function _cap(uint256 staked) internal view returns (uint256) {
        return (staked * maxEnergyPerStake) / ACC;
    }

    /// @notice Current energy of `user` (view — accounts for regen since last touch).
    function energyOf(address user) public view returns (uint256) {
        Account memory a = accounts[user];
        if (a.last == 0 || a.staked == 0) return a.energy;
        uint256 regen = ((block.timestamp - a.last) * a.staked * energyPerStakePerSecond) / ACC;
        uint256 cap = _cap(a.staked);
        uint256 e = a.energy + regen;
        return e > cap ? cap : e;
    }

    /// @notice Energy refilled per second at the user's current stake.
    function regenRatePerSecond(address user) external view returns (uint256) {
        return (accounts[user].staked * energyPerStakePerSecond) / ACC;
    }

    function _settle(address user) internal {
        accounts[user].energy = energyOf(user);
        accounts[user].last = uint64(block.timestamp);
    }

    function stake(uint256 amount) external {
        require(amount > 0, "amount=0");
        _settle(msg.sender);
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        accounts[msg.sender].staked += amount;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external {
        _settle(msg.sender);
        Account storage a = accounts[msg.sender];
        require(a.staked >= amount && amount > 0, "bad amount");
        a.staked -= amount;
        uint256 cap = _cap(a.staked);
        if (a.energy > cap) a.energy = cap;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Spend `amount` energy (called by a gas-sponsor/relayer integrated with this meter).
    function spend(uint256 amount) external {
        _settle(msg.sender);
        require(accounts[msg.sender].energy >= amount, "insufficient energy");
        accounts[msg.sender].energy -= amount;
        emit Spent(msg.sender, amount);
    }
}
