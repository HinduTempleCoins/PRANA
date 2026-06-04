// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SeasonPass
/// @notice A tiered battle-pass with non-rollover reward claims.
///         An admin configures a season: per-tier XP thresholds and the reward amount paid
///         out for each tier (denominated in a reward ERC-20 funded into this contract).
///         A backend holding GRANTER_ROLE accrues XP for players via {addXp}. Once a player
///         reaches a tier's XP threshold they may {claimTier} exactly once to collect that
///         tier's reward. {startNewSeason} bumps the season id, resetting all XP and claim
///         state (rewards do NOT roll over between seasons).
contract SeasonPass is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant GRANTER_ROLE = keccak256("GRANTER_ROLE");

    /// @notice The ERC-20 token rewards are paid in.
    IERC20 public immutable rewardToken;

    /// @notice Monotonically increasing season identifier. Bumped by {startNewSeason}.
    uint256 public seasonId;

    /// @notice XP threshold required to unlock each tier in the current season.
    uint256[] public tierThresholds;

    /// @notice Reward amount paid for each tier in the current season.
    uint256[] public tierRewards;

    /// @dev seasonId => player => accrued XP for that season.
    mapping(uint256 => mapping(address => uint256)) private _xp;

    /// @dev seasonId => player => tier => whether that tier has been claimed.
    mapping(uint256 => mapping(address => mapping(uint256 => bool))) private _claimed;

    event SeasonStarted(uint256 indexed seasonId, uint256[] thresholds, uint256[] rewards);
    event XpAdded(uint256 indexed seasonId, address indexed player, uint256 amount, uint256 newTotal);
    event TierClaimed(uint256 indexed seasonId, address indexed player, uint256 indexed tier, uint256 reward);

    /// @param rewardToken_ ERC-20 used to pay tier rewards (must be funded into this contract).
    /// @param thresholds   XP threshold per tier (index = tier id).
    /// @param rewards      reward amount per tier (parallel to `thresholds`).
    /// @param admin        receives DEFAULT_ADMIN_ROLE and GRANTER_ROLE.
    constructor(
        IERC20 rewardToken_,
        uint256[] memory thresholds,
        uint256[] memory rewards,
        address admin
    ) {
        require(address(rewardToken_) != address(0), "reward token=0");
        require(admin != address(0), "admin=0");
        rewardToken = rewardToken_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GRANTER_ROLE, admin);

        _configureSeason(thresholds, rewards);
        // seasonId starts at 0; emit the genesis season for indexers.
        emit SeasonStarted(seasonId, thresholds, rewards);
    }

    /// @notice Number of tiers configured in the current season.
    function tierCount() external view returns (uint256) {
        return tierThresholds.length;
    }

    /// @notice XP accrued by `player` in the current season.
    function xpOf(address player) external view returns (uint256) {
        return _xp[seasonId][player];
    }

    /// @notice Whether `player` has claimed `tier` in the current season.
    function hasClaimed(address player, uint256 tier) external view returns (bool) {
        return _claimed[seasonId][player][tier];
    }

    /// @notice Accrue `amount` XP for `player` in the current season. Backend-only.
    function addXp(address player, uint256 amount) external onlyRole(GRANTER_ROLE) {
        require(player != address(0), "player=0");
        require(amount > 0, "amount=0");
        uint256 newTotal = _xp[seasonId][player] + amount;
        _xp[seasonId][player] = newTotal;
        emit XpAdded(seasonId, player, amount, newTotal);
    }

    /// @notice Claim the reward for `tier` once the caller has reached its XP threshold.
    /// @dev Reverts if the tier is invalid, the threshold is unmet, or it was already claimed.
    function claimTier(uint256 tier) external {
        require(tier < tierThresholds.length, "invalid tier");
        uint256 season = seasonId;
        require(_xp[season][msg.sender] >= tierThresholds[tier], "threshold not met");
        require(!_claimed[season][msg.sender][tier], "already claimed");

        _claimed[season][msg.sender][tier] = true;
        uint256 reward = tierRewards[tier];
        emit TierClaimed(season, msg.sender, tier, reward);

        if (reward > 0) {
            rewardToken.safeTransfer(msg.sender, reward);
        }
    }

    /// @notice Bump the season id, resetting all XP/claims, and set new tier config. Admin-only.
    function startNewSeason(uint256[] calldata thresholds, uint256[] calldata rewards)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        seasonId += 1;
        _configureSeason(thresholds, rewards);
        emit SeasonStarted(seasonId, thresholds, rewards);
    }

    /// @dev Validate and store the per-tier threshold/reward arrays for the current season.
    function _configureSeason(uint256[] memory thresholds, uint256[] memory rewards) private {
        require(thresholds.length == rewards.length, "length mismatch");
        require(thresholds.length > 0, "no tiers");
        tierThresholds = thresholds;
        tierRewards = rewards;
    }
}
