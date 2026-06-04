// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ERC721Staking — stake NFTs to earn a fixed ERC-20 reward per NFT per second
/// @notice thirdweb-style NFT staking. Each staked NFT accrues `rewardRate` reward-token
///         units per second. Rewards are paid from this contract's pre-funded reward balance
///         (fund it by transferring the reward token in, or via `fundRewards`). No minting —
///         the reward token is just an ordinary ERC-20 held by this contract.
///
///         Accounting is the standard "settle on every interaction" pattern:
///         on stake/withdraw/claim we first credit `stored += rate * count * elapsed`, then
///         move the NFT set / pay out. `earned(user)` adds the live (unsettled) accrual on top.
contract ERC721Staking is ERC721Holder {
    using SafeERC20 for IERC20;

    IERC721 public immutable nft;
    IERC20 public immutable rewardToken;
    /// @notice Reward-token units accrued per staked NFT per second.
    uint256 public immutable rewardRate;

    struct StakeInfo {
        uint256 count;       // number of NFTs currently staked by the user
        uint256 lastUpdate;  // timestamp of last settlement
        uint256 stored;      // settled-but-unclaimed reward
    }

    mapping(address => StakeInfo) public stakes;
    /// @notice Owner who staked a given tokenId (0 if not staked here).
    mapping(uint256 => address) public stakerOf;

    event Staked(address indexed user, uint256[] tokenIds);
    event Withdrawn(address indexed user, uint256[] tokenIds);
    event Claimed(address indexed user, uint256 amount);

    constructor(IERC721 nft_, IERC20 rewardToken_, uint256 rewardRate_) {
        require(address(nft_) != address(0) && address(rewardToken_) != address(0), "zero addr");
        require(rewardRate_ > 0, "rate=0");
        nft = nft_;
        rewardToken = rewardToken_;
        rewardRate = rewardRate_;
    }

    /// @notice Anyone may top up the reward pool (e.g. owner pre-funds at deploy time).
    function fundRewards(uint256 amount) external {
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Total reward `user` has accrued: settled `stored` + live accrual since lastUpdate.
    function earned(address user) public view returns (uint256) {
        StakeInfo storage s = stakes[user];
        uint256 pending = s.count * rewardRate * (block.timestamp - s.lastUpdate);
        return s.stored + pending;
    }

    /// @dev Settle live accrual into `stored` and reset the accrual clock.
    function _settle(address user) internal {
        StakeInfo storage s = stakes[user];
        s.stored += s.count * rewardRate * (block.timestamp - s.lastUpdate);
        s.lastUpdate = block.timestamp;
    }

    /// @notice Stake NFTs: pull them in and start accrual for the caller.
    function stake(uint256[] calldata tokenIds) external {
        require(tokenIds.length > 0, "empty");
        _settle(msg.sender);
        StakeInfo storage s = stakes[msg.sender];
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            nft.safeTransferFrom(msg.sender, address(this), id);
            stakerOf[id] = msg.sender;
        }
        s.count += tokenIds.length;
        emit Staked(msg.sender, tokenIds);
    }

    /// @notice Settle rewards and return the given NFTs to the caller, stopping their accrual.
    function withdraw(uint256[] calldata tokenIds) external {
        require(tokenIds.length > 0, "empty");
        _settle(msg.sender);
        StakeInfo storage s = stakes[msg.sender];
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            require(stakerOf[id] == msg.sender, "not your stake");
            delete stakerOf[id];
            nft.safeTransferFrom(address(this), msg.sender, id);
        }
        s.count -= tokenIds.length;
        emit Withdrawn(msg.sender, tokenIds);
    }

    /// @notice Pay out all accrued reward to the caller from the contract's reward balance.
    function claim() external returns (uint256 amount) {
        _settle(msg.sender);
        StakeInfo storage s = stakes[msg.sender];
        amount = s.stored;
        require(amount > 0, "nothing to claim");
        s.stored = 0;
        rewardToken.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
