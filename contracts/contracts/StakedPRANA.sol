// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StakedPRANA (sPRANA) — the staked-wrapped PRANA governance token.
/// @notice Stake native PRANA 1:1 to mint sPRANA, the `ERC20Votes` vote weight for the PRANA DAO
///         (the Pool/Chain is the DAO). Unstaking is NOT instant: you `requestWithdraw`, which burns
///         your sPRANA immediately (so your vote weight drops at once — no vote-then-dump), then after a
///         30-day cooldown you `claim` the native PRANA back. Operator spec 2026-06-17.
/// @dev    Vote weight = checkpointed sPRANA balance; holders should `delegate(self)` to activate it —
///         `stake` auto-self-delegates on a first stake for UX. block.number clock (matches GovernorDAO).
contract StakedPRANA is ERC20, ERC20Permit, ERC20Votes, ReentrancyGuard {
    /// @notice Cooldown between requesting a withdrawal and being able to claim the native PRANA.
    uint256 public constant WITHDRAW_COOLDOWN = 30 days;

    struct Unbond {
        uint256 amount;     // native PRANA queued
        uint256 releaseAt;  // timestamp it becomes claimable
    }

    /// @notice Per-user FIFO queue of in-flight unbondings.
    mapping(address => Unbond[]) private _unbonding;
    /// @notice Total native PRANA reserved by in-flight unbondings (never re-stakeable until claimed).
    uint256 public unbondingTotal;

    event Staked(address indexed user, uint256 amount);
    event WithdrawRequested(address indexed user, uint256 amount, uint256 releaseAt);
    event Claimed(address indexed user, uint256 amount);

    error ZeroAmount();
    error InsufficientStake();
    error NothingClaimable();
    error TransferFailed();

    constructor() ERC20("Staked PRANA", "sPRANA") ERC20Permit("Staked PRANA") {}

    /// @notice Stake native PRANA → mint an equal amount of sPRANA (1:1). Auto-self-delegates the first
    ///         time so the new vote weight is active immediately.
    function stake() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (delegates(msg.sender) == address(0)) _delegate(msg.sender, msg.sender);
        _mint(msg.sender, msg.value);
        emit Staked(msg.sender, msg.value);
    }

    /// @notice Begin unstaking `amount`: burns the sPRANA now (vote weight drops immediately) and queues
    ///         the native PRANA for claim after WITHDRAW_COOLDOWN.
    function requestWithdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < amount) revert InsufficientStake();
        _burn(msg.sender, amount);
        uint256 releaseAt = block.timestamp + WITHDRAW_COOLDOWN;
        _unbonding[msg.sender].push(Unbond({amount: amount, releaseAt: releaseAt}));
        unbondingTotal += amount;
        emit WithdrawRequested(msg.sender, amount, releaseAt);
    }

    /// @notice Claim every matured unbonding for the caller, sending the native PRANA back.
    function claim() external nonReentrant {
        Unbond[] storage q = _unbonding[msg.sender];
        uint256 payout;
        uint256 i;
        while (i < q.length) {
            if (block.timestamp >= q[i].releaseAt) {
                payout += q[i].amount;
                q[i] = q[q.length - 1]; // swap-pop the matured entry
                q.pop();
            } else {
                i++;
            }
        }
        if (payout == 0) revert NothingClaimable();
        unbondingTotal -= payout;
        emit Claimed(msg.sender, payout);
        (bool ok, ) = payable(msg.sender).call{value: payout}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice In-flight unbondings for `user` (amount + releaseAt each).
    function unbondingOf(address user) external view returns (Unbond[] memory) {
        return _unbonding[user];
    }

    /// @notice Total claimable-now native PRANA for `user`.
    function claimableOf(address user) external view returns (uint256 claimable) {
        Unbond[] storage q = _unbonding[user];
        for (uint256 i; i < q.length; i++) {
            if (block.timestamp >= q[i].releaseAt) claimable += q[i].amount;
        }
    }

    // --- OZ v5 multiple-inheritance plumbing ---------------------------------
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
