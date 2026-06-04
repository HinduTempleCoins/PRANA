// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title StakeLock — lock a token for a chosen duration → non-transferable resource credit
/// @notice Lock `lockToken` for one of the admin-configured duration *tiers*. At lock time you mint
///         a soulbound "resource credit" balance = `amount * multiplierBps / 10_000`, where the
///         multiplier is the bps weight an admin set for that tier (longer tier → larger multiplier).
///         Credits decay linearly to zero over the lock window (full at lock, zero at unlock) and are
///         never transferable — they exist only as accounting for downstream gating via
///         `creditsOf(account)`. After unlock the principal is withdrawable.
contract StakeLock is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant TIER_ADMIN_ROLE = keccak256("TIER_ADMIN_ROLE");
    uint256 private constant BPS = 10_000;

    IERC20 public immutable lockToken;

    /// @dev multiplierBps for a given lock duration (seconds). 0 == tier not enabled.
    mapping(uint256 => uint256) public multiplierBps;

    struct Position {
        uint256 amount;       // principal locked
        uint256 baseCredits;  // credits at lock time (decay from here to 0)
        uint64 start;         // lock timestamp
        uint64 end;           // unlock timestamp
    }
    mapping(address => Position) public positions;

    event TierSet(uint256 indexed duration, uint256 multiplierBps);
    event Locked(address indexed user, uint256 amount, uint256 duration, uint256 baseCredits, uint64 end);
    event Withdrawn(address indexed user, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error BadTier();
    error PositionExists();
    error NoPosition();
    error StillLocked();

    constructor(IERC20 lockToken_, address admin) {
        if (address(lockToken_) == address(0) || admin == address(0)) revert ZeroAddress();
        lockToken = lockToken_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TIER_ADMIN_ROLE, admin);
    }

    /// @notice Configure (or disable, with `bps == 0`) the credit multiplier for a duration tier.
    function setTier(uint256 duration, uint256 bps) external onlyRole(TIER_ADMIN_ROLE) {
        if (duration == 0) revert BadTier();
        multiplierBps[duration] = bps;
        emit TierSet(duration, bps);
    }

    /// @notice Lock `amount` for an enabled `duration` tier, minting decaying resource credits.
    function lock(uint256 amount, uint256 duration) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bps = multiplierBps[duration];
        if (bps == 0) revert BadTier();
        Position storage p = positions[msg.sender];
        if (p.amount != 0) revert PositionExists();

        uint256 baseCredits = (amount * bps) / BPS;
        lockToken.safeTransferFrom(msg.sender, address(this), amount);

        p.amount = amount;
        p.baseCredits = baseCredits;
        p.start = uint64(block.timestamp);
        p.end = uint64(block.timestamp + duration);

        emit Locked(msg.sender, amount, duration, baseCredits, p.end);
    }

    /// @notice Current decaying resource credits of `account` (full at lock, 0 at/after unlock).
    function creditsOf(address account) public view returns (uint256) {
        Position memory p = positions[account];
        if (p.baseCredits == 0 || block.timestamp >= p.end) return 0;
        uint256 remaining = p.end - block.timestamp;
        uint256 span = p.end - p.start;
        return (p.baseCredits * remaining) / span;
    }

    /// @notice Withdraw the principal once the lock has elapsed. Clears credits.
    function withdraw() external {
        Position storage p = positions[msg.sender];
        if (p.amount == 0) revert NoPosition();
        if (block.timestamp < p.end) revert StillLocked();

        uint256 amount = p.amount;
        delete positions[msg.sender];
        lockToken.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }
}
