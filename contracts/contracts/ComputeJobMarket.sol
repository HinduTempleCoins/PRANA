// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ComputeJobMarket
/// @notice Off-chain compute job board with on-chain escrow and oracle-attested
///         settlement (off-chain-verified compute model). A requester posts a job and escrows the
///         reward; a worker accepts it; an allowlisted verifier settles it,
///         either paying the worker (success) or refunding the requester (failure).
contract ComputeJobMarket is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    enum Status {
        None,
        Open,
        Assigned,
        Completed,
        Failed,
        Cancelled
    }

    struct Job {
        address requester;
        address worker;
        IERC20 payToken;
        uint256 reward;
        bytes32 spec;
        Status status;
    }

    uint256 public nextId;
    mapping(uint256 => Job) public jobs;

    event JobPosted(
        uint256 indexed id,
        address indexed requester,
        address payToken,
        uint256 reward,
        bytes32 spec
    );
    event JobAccepted(uint256 indexed id, address indexed worker);
    event JobSettled(uint256 indexed id, bool success, address indexed paidTo);
    event JobCancelled(uint256 indexed id);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
    }

    /// @notice Post a new compute job, escrowing `reward` of `payToken`.
    /// @return id The id of the newly created job.
    function postJob(IERC20 payToken, uint256 reward, bytes32 spec) external returns (uint256 id) {
        require(reward > 0, "reward=0");
        id = nextId++;
        jobs[id] = Job({
            requester: msg.sender,
            worker: address(0),
            payToken: payToken,
            reward: reward,
            spec: spec,
            status: Status.Open
        });
        payToken.safeTransferFrom(msg.sender, address(this), reward);
        emit JobPosted(id, msg.sender, address(payToken), reward, spec);
    }

    /// @notice A worker accepts an open job, becoming its assignee.
    function accept(uint256 id) external {
        Job storage job = jobs[id];
        require(job.status == Status.Open, "not open");
        job.worker = msg.sender;
        job.status = Status.Assigned;
        emit JobAccepted(id, msg.sender);
    }

    /// @notice An allowlisted verifier settles an assigned job. On success the
    ///         worker is paid; on failure the requester is refunded.
    function settle(uint256 id, bool success) external onlyRole(VERIFIER_ROLE) {
        Job storage job = jobs[id];
        require(job.status == Status.Assigned, "not assigned");

        address paidTo;
        if (success) {
            job.status = Status.Completed;
            paidTo = job.worker;
        } else {
            job.status = Status.Failed;
            paidTo = job.requester;
        }
        job.payToken.safeTransfer(paidTo, job.reward);
        emit JobSettled(id, success, paidTo);
    }

    /// @notice The requester cancels an open (unaccepted) job and is refunded.
    function cancel(uint256 id) external {
        Job storage job = jobs[id];
        require(job.status == Status.Open, "not open");
        require(job.requester == msg.sender, "not requester");
        job.status = Status.Cancelled;
        job.payToken.safeTransfer(job.requester, job.reward);
        emit JobCancelled(id);
    }
}
