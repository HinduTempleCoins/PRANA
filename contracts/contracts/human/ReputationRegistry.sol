// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";

/// @title ReputationRegistry (AG2) — per-contributor reputation + optional slashable stake.
/// @notice A NON-TRANSFERABLE score that rises on verified good work and falls on slashes. Governed
///         tier thresholds bucket the raw score into discrete access tiers; human task-types name a
///         minimum tier ({HumanTaskRegistry.minReputation}) which {HumanTaskCreditor} enforces before
///         crediting pooled value. Optionally a contributor posts a PRANA stake as a good-faith bond;
///         a SLASHER role can burn part of that stake (sent to a treasury) when work is garbage,
///         simultaneously docking reputation. The score is soulbound — there is no transfer path.
/// @dev Composition: this is a sibling of {AttestationStakeSlash} (which stakes ATTESTORS). This one
///      tracks CONTRIBUTOR reputation + an optional contributor bond. Kept separate so the two
///      economic roles (who verifies vs who is paid) never share a balance.
contract ReputationRegistry is AccessControl, IReputationRegistry {
    using SafeERC20 for IERC20;

    /// @notice May raise reputation on verified good work (the {HumanContributionGate} / creditor).
    bytes32 public constant SCORER_ROLE = keccak256("SCORER_ROLE");
    /// @notice May dock reputation and slash the contributor's bond for garbage work (the DAO/keeper).
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    /// @notice May set the governed tier thresholds (the DAO timelock).
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    /// @notice Optional PRANA bond token. address(0) ⇒ stake feature disabled (reputation-only mode).
    IERC20 public immutable stakeToken;
    /// @notice Where slashed bond funds are sent.
    address public treasury;

    /// @dev contributor → raw non-transferable reputation score.
    mapping(address => uint256) private _reputation;
    /// @dev contributor → posted good-faith bond (slashable).
    mapping(address => uint256) private _stake;

    /// @dev Ascending tier thresholds. tier(score) = number of thresholds <= score. An empty array
    ///      means everyone is tier 0; thresholds[i] is the minimum score to reach tier (i+1).
    uint256[] private _tierThresholds;

    event ReputationGained(address indexed who, uint256 amount, uint256 newScore);
    event ReputationDocked(address indexed who, uint256 amount, uint256 newScore);
    event Staked(address indexed who, uint256 amount, uint256 newStake);
    event Unstaked(address indexed who, uint256 amount, uint256 newStake);
    event StakeSlashed(address indexed who, uint256 amount, uint256 newStake, address indexed treasury);
    event TierThresholdsSet(uint256[] thresholds);
    event TreasurySet(address indexed treasury);

    error ZeroAmount();
    error ZeroAddress();
    error StakeDisabled();
    error AmountExceedsStake(uint256 amount, uint256 stake);
    error ThresholdsNotAscending();

    /// @param stakeToken_ optional PRANA bond token; pass address(0) for reputation-only mode.
    /// @param treasury_   slash destination (required iff stakeToken_ set, else may be any nonzero).
    /// @param admin       DEFAULT_ADMIN_ROLE + SCORER/SLASHER/GOVERNOR bootstrap holder (DAO in prod).
    constructor(IERC20 stakeToken_, address treasury_, address admin) {
        require(admin != address(0), "admin=0");
        require(treasury_ != address(0), "treasury=0");
        stakeToken = stakeToken_; // may be zero (reputation-only)
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCORER_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        emit TreasurySet(treasury_);
    }

    // ------------------------------------------------------------------------------------------
    // Reputation (soulbound: no transfer path exists)
    // ------------------------------------------------------------------------------------------

    /// @notice Raise `who`'s reputation by `amount` (verified good work). SCORER_ROLE only.
    function gain(address who, uint256 amount) external onlyRole(SCORER_ROLE) {
        if (who == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 s = _reputation[who] + amount;
        _reputation[who] = s;
        emit ReputationGained(who, amount, s);
    }

    /// @notice Dock `who`'s reputation by up to `amount` (saturating at 0). SLASHER_ROLE only.
    function dock(address who, uint256 amount) external onlyRole(SLASHER_ROLE) {
        if (who == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 cur = _reputation[who];
        uint256 s = amount >= cur ? 0 : cur - amount;
        _reputation[who] = s;
        emit ReputationDocked(who, cur - s, s);
    }

    // ------------------------------------------------------------------------------------------
    // Optional good-faith bond
    // ------------------------------------------------------------------------------------------

    /// @notice Post `amount` PRANA as a slashable good-faith bond.
    function stake(uint256 amount) external {
        if (address(stakeToken) == address(0)) revert StakeDisabled();
        if (amount == 0) revert ZeroAmount();
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 s = _stake[msg.sender] + amount;
        _stake[msg.sender] = s;
        emit Staked(msg.sender, amount, s);
    }

    /// @notice Withdraw `amount` of the caller's remaining (unslashed) bond.
    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 cur = _stake[msg.sender];
        if (amount > cur) revert AmountExceedsStake(amount, cur);
        uint256 s = cur - amount;
        _stake[msg.sender] = s;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, s);
    }

    /// @notice Slash `amount` of `who`'s bond to the treasury (garbage work). SLASHER_ROLE only.
    function slashStake(address who, uint256 amount) external onlyRole(SLASHER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        uint256 cur = _stake[who];
        if (amount > cur) revert AmountExceedsStake(amount, cur);
        uint256 s = cur - amount;
        _stake[who] = s;
        stakeToken.safeTransfer(treasury, amount);
        emit StakeSlashed(who, amount, s, treasury);
    }

    // ------------------------------------------------------------------------------------------
    // Governed config
    // ------------------------------------------------------------------------------------------

    /// @notice Set the ascending tier thresholds. thresholds[i] = min score for tier (i+1).
    function setTierThresholds(uint256[] calldata thresholds) external onlyRole(GOVERNOR_ROLE) {
        uint256 len = thresholds.length;
        for (uint256 i = 1; i < len; ++i) {
            if (thresholds[i] <= thresholds[i - 1]) revert ThresholdsNotAscending();
        }
        _tierThresholds = thresholds;
        emit TierThresholdsSet(thresholds);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // ------------------------------------------------------------------------------------------
    // IReputationRegistry reads
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IReputationRegistry
    function reputationOf(address who) external view returns (uint256) {
        return _reputation[who];
    }

    /// @inheritdoc IReputationRegistry
    /// @notice tier = number of thresholds the score meets or exceeds (tier 0 = below first threshold).
    function tierOf(address who) public view returns (uint256) {
        uint256 score = _reputation[who];
        uint256 len = _tierThresholds.length;
        uint256 t;
        for (uint256 i; i < len; ++i) {
            if (score >= _tierThresholds[i]) {
                ++t;
            } else {
                break; // ascending → first miss ends it
            }
        }
        return t;
    }

    /// @inheritdoc IReputationRegistry
    function stakeOf(address who) external view returns (uint256) {
        return _stake[who];
    }

    /// @notice The configured ascending tier thresholds.
    function tierThresholds() external view returns (uint256[] memory) {
        return _tierThresholds;
    }
}
