// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ContributionBountyEscrow — pay for verified contributions (DevCoin/Gitcoin/Bounty0x)
/// @notice A sponsor escrows tokens against a bounty; an allowlisted attestor (the off-chain verifier)
///         releases it to the worker who completed the work; the sponsor can cancel an unclaimed
///         bounty for a refund. One of the three "prove a contribution → get paid" rails (with
///         compute and solar) — differentiated only by the oracle.
contract ContributionBountyEscrow is AccessControl {
    using SafeERC20 for IERC20;
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

    IERC20 public immutable token;

    struct Bounty {
        address sponsor;
        uint256 amount;
        address worker;
        bool paid;
        bool cancelled;
    }
    Bounty[] public bounties;

    event Posted(uint256 indexed id, address indexed sponsor, uint256 amount);
    event Released(uint256 indexed id, address indexed worker, uint256 amount);
    event Cancelled(uint256 indexed id);

    constructor(IERC20 token_, address admin) {
        require(address(token_) != address(0) && admin != address(0), "zero");
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, admin);
    }

    function post(uint256 amount) external returns (uint256 id) {
        require(amount > 0, "amount=0");
        token.safeTransferFrom(msg.sender, address(this), amount);
        id = bounties.length;
        bounties.push(Bounty(msg.sender, amount, address(0), false, false));
        emit Posted(id, msg.sender, amount);
    }

    function attestAndRelease(uint256 id, address worker) external onlyRole(ATTESTOR_ROLE) {
        Bounty storage b = bounties[id];
        require(!b.paid && !b.cancelled, "closed");
        require(worker != address(0), "worker=0");
        b.paid = true;
        b.worker = worker;
        token.safeTransfer(worker, b.amount);
        emit Released(id, worker, b.amount);
    }

    function cancel(uint256 id) external {
        Bounty storage b = bounties[id];
        require(msg.sender == b.sponsor, "not sponsor");
        require(!b.paid && !b.cancelled, "closed");
        b.cancelled = true;
        token.safeTransfer(b.sponsor, b.amount);
        emit Cancelled(id);
    }

    function count() external view returns (uint256) {
        return bounties.length;
    }
}
