// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BountyPoolEscrow — funded bounty pools: a sponsor puts up a pot, many workers each earn one reward
/// @notice Matches the Pentecaust Bounty Pools model (pot, perTaskReward, slots, deadline). Any ERC-20 per pool,
///         so different bounties pay in different tokens. An allowlisted attestor (the off-chain verifier)
///         releases one reward per verified task; each task reference can be paid once. The sponsor gets back
///         only what is left, and only after the pool's deadline — so nobody's finished work can be cancelled
///         out from under them.
/// @dev Replaces ContributionBountyEscrow for pools (that contract is one bounty → one payout, single token,
///      cancellable at any time). Fee-on-transfer tokens are refused: the pot must arrive in full.
contract BountyPoolEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    uint64 public constant MIN_DURATION = 1 days;

    struct Pool {
        address sponsor;
        IERC20 token;
        uint128 perTaskReward;
        uint32 slotsLeft;
        uint64 deadline;
        bytes32 ref;       // off-chain pool id / description hash
        uint256 balance;   // tokens still held for this pool
    }

    Pool[] public pools;
    mapping(uint256 => mapping(bytes32 => bool)) public taskPaid; // poolId => taskRef => paid

    event PoolCreated(uint256 indexed id, address indexed sponsor, address indexed token, uint256 perTaskReward, uint256 slots, uint256 deadline, bytes32 ref);
    event Released(uint256 indexed id, address indexed worker, bytes32 indexed taskRef, uint256 amount);
    event Reclaimed(uint256 indexed id, address indexed sponsor, uint256 amount);

    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, admin);
    }

    /// @notice Fund a pool of `slots` rewards of `perTaskReward` each, open until `deadline`.
    function createPool(IERC20 token, uint128 perTaskReward, uint32 slots, uint64 deadline, bytes32 ref)
        external nonReentrant returns (uint256 id)
    {
        require(address(token) != address(0), "token=0");
        require(perTaskReward > 0 && slots > 0, "empty pool");
        require(deadline >= block.timestamp + MIN_DURATION, "deadline too soon");
        uint256 pot = uint256(perTaskReward) * slots;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), pot);
        require(token.balanceOf(address(this)) - before == pot, "fee-on-transfer token");
        id = pools.length;
        pools.push(Pool(msg.sender, token, perTaskReward, slots, deadline, ref, pot));
        emit PoolCreated(id, msg.sender, address(token), perTaskReward, slots, deadline, ref);
    }

    /// @notice Pay one verified task. Each `taskRef` (e.g. hash of the submission) can be paid once per pool.
    function release(uint256 id, address worker, bytes32 taskRef) external onlyRole(ATTESTOR_ROLE) nonReentrant {
        Pool storage p = pools[id];
        require(worker != address(0), "worker=0");
        require(block.timestamp <= p.deadline, "pool closed");
        require(p.slotsLeft > 0, "no slots left");
        require(!taskPaid[id][taskRef], "task already paid");
        taskPaid[id][taskRef] = true;
        p.slotsLeft -= 1;
        p.balance -= p.perTaskReward;
        p.token.safeTransfer(worker, p.perTaskReward);
        emit Released(id, worker, taskRef, p.perTaskReward);
    }

    /// @notice After the deadline, the sponsor takes back whatever was not paid out.
    function reclaim(uint256 id) external nonReentrant {
        Pool storage p = pools[id];
        require(msg.sender == p.sponsor, "not sponsor");
        require(block.timestamp > p.deadline, "pool still open");
        uint256 amt = p.balance;
        require(amt > 0, "nothing left");
        p.balance = 0;
        p.slotsLeft = 0;
        p.token.safeTransfer(p.sponsor, amt);
        emit Reclaimed(id, p.sponsor, amt);
    }

    function count() external view returns (uint256) {
        return pools.length;
    }
}
