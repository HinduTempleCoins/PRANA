// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AttestationStakeSlash
/// @notice Shared staking + slashing module for PRANA oracle attestors. Attestors stake a
///         `stakeToken`; while their stake is >= `minStake` they are "active" and may record
///         attestations against claim ids. A SLASHER_ROLE can slash a misbehaving attestor —
///         slashed funds are transferred to a treasury. Attestors may unstake any balance they
///         still hold (slashed funds are gone and cannot be withdrawn). Kept deliberately generic
///         so multiple oracle contracts (solar, useful-work, etc.) can share one stake registry.
contract AttestationStakeSlash is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    IERC20 public immutable stakeToken;
    uint256 public immutable minStake;
    address public treasury;

    mapping(address => uint256) public stakeOf;

    event Staked(address indexed attestor, uint256 amount, uint256 newStake);
    event Unstaked(address indexed attestor, uint256 amount, uint256 newStake);
    event Attested(address indexed attestor, bytes32 indexed claimId);
    event Slashed(address indexed attestor, uint256 amount, uint256 newStake, address indexed treasury);

    constructor(IERC20 stakeToken_, uint256 minStake_, address treasury_, address admin) {
        require(address(stakeToken_) != address(0), "stakeToken=0");
        require(treasury_ != address(0), "treasury=0");
        require(admin != address(0), "admin=0");
        require(minStake_ > 0, "minStake=0");
        stakeToken = stakeToken_;
        minStake = minStake_;
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);
    }

    /// @notice True once an attestor holds at least `minStake`.
    function isActive(address attestor) public view returns (bool) {
        return stakeOf[attestor] >= minStake;
    }

    /// @notice Pull `amount` of stakeToken from the caller and credit their stake.
    function stake(uint256 amount) external {
        require(amount > 0, "amount=0");
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 newStake = stakeOf[msg.sender] + amount;
        stakeOf[msg.sender] = newStake;
        emit Staked(msg.sender, amount, newStake);
    }

    /// @notice Record an attestation. Caller must currently be active (>= minStake).
    function attest(bytes32 claimId) external {
        require(isActive(msg.sender), "not active");
        emit Attested(msg.sender, claimId);
    }

    /// @notice Slash an attestor; the funds are sent to the treasury. May deactivate the attestor
    ///         if their remaining stake falls below minStake.
    function slash(address attestor, uint256 amount) external onlyRole(SLASHER_ROLE) {
        uint256 current = stakeOf[attestor];
        require(amount > 0, "amount=0");
        require(amount <= current, "amount>stake");
        uint256 newStake = current - amount;
        stakeOf[attestor] = newStake;
        stakeToken.safeTransfer(treasury, amount);
        emit Slashed(attestor, amount, newStake, treasury);
    }

    /// @notice Withdraw `amount` of the caller's remaining stake back to them.
    function unstake(uint256 amount) external {
        uint256 current = stakeOf[msg.sender];
        require(amount > 0, "amount=0");
        require(amount <= current, "amount>stake");
        uint256 newStake = current - amount;
        stakeOf[msg.sender] = newStake;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, newStake);
    }
}
