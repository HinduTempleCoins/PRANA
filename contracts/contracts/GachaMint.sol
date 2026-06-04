// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GachaMint
/// @notice A commit-reveal gacha that mints an ERC-721 of a *disclosed* rarity.
/// @dev Anti-loot-box guardrail: the rarity names and weights are fixed at construction
///      and exposed verbatim through public views (`rarityWeights`, `rarityName`,
///      `rarityCount`, `totalWeight`). There is no hidden odds state. Randomness comes
///      from a future blockhash committed to before it is known (commit-reveal), so the
///      operator cannot grind outcomes. Pull is paid in an ERC-20 set at construction.
contract GachaMint is ERC721, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice The ERC-20 charged per pull.
    IERC20 public immutable payToken;

    /// @notice Price (in payToken base units) charged on `commit`.
    uint256 public immutable price;

    /// @notice Where collected payment is forwarded.
    address public immutable treasury;

    /// @notice Disclosed rarity names, index-aligned with `_weights`.
    string[] private _names;

    /// @notice Disclosed rarity weights, index-aligned with `_names`.
    uint256[] private _weights;

    /// @notice Sum of all weights (cached).
    uint256 public totalWeight;

    /// @notice Optional pity: number of pulls without the rarest tier that guarantees it.
    ///         0 disables pity entirely.
    uint256 public immutable pityThreshold;

    /// @notice Block number of a user's currently-open commit (0 = none open).
    mapping(address => uint256) public commits;

    /// @notice Consecutive non-legendary reveals per user (for pity).
    mapping(address => uint256) public pityCounter;

    /// @notice Rarity assigned to each minted tokenId.
    mapping(uint256 => uint256) public rarityOf;

    uint256 private _nextId;

    event Committed(address indexed user, uint256 commitBlock);
    event Revealed(address indexed user, uint256 indexed tokenId, uint256 rarityIndex);

    error LengthMismatch();
    error NoRarities();
    error ZeroWeight();
    error CommitOpen();
    error NoCommit();
    error TooEarly();
    error TooLate();

    /// @param name_ ERC-721 collection name.
    /// @param symbol_ ERC-721 collection symbol.
    /// @param payToken_ ERC-20 used to pay for pulls.
    /// @param price_ Cost per pull in payToken base units.
    /// @param treasury_ Recipient of collected payment.
    /// @param rarityNames Disclosed rarity names (e.g. ["Common","Rare","Legendary"]).
    /// @param rarityWeights_ Disclosed weights (e.g. [70, 25, 5]).
    /// @param pityThreshold_ Pulls-without-rarest that force the rarest tier (0 = off).
    /// @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 payToken_,
        uint256 price_,
        address treasury_,
        string[] memory rarityNames,
        uint256[] memory rarityWeights_,
        uint256 pityThreshold_,
        address admin
    ) ERC721(name_, symbol_) {
        if (rarityNames.length != rarityWeights_.length) revert LengthMismatch();
        if (rarityNames.length == 0) revert NoRarities();

        uint256 sum;
        for (uint256 i = 0; i < rarityWeights_.length; i++) {
            if (rarityWeights_[i] == 0) revert ZeroWeight();
            sum += rarityWeights_[i];
            _names.push(rarityNames[i]);
            _weights.push(rarityWeights_[i]);
        }
        totalWeight = sum;

        payToken = payToken_;
        price = price_;
        treasury = treasury_;
        pityThreshold = pityThreshold_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //  Disclosed-odds views (anti-loot-box: no hidden state)                //
    // --------------------------------------------------------------------- //

    /// @notice The configured weights, index-aligned with `rarityName`. Odds disclosed.
    function rarityWeights() external view returns (uint256[] memory) {
        return _weights;
    }

    /// @notice The configured rarity names.
    function rarityNames() external view returns (string[] memory) {
        return _names;
    }

    /// @notice Number of rarity tiers.
    function rarityCount() external view returns (uint256) {
        return _weights.length;
    }

    /// @notice Name of a given rarity tier.
    function rarityName(uint256 index) external view returns (string memory) {
        return _names[index];
    }

    /// @notice Weight of a given rarity tier.
    function rarityWeight(uint256 index) external view returns (uint256) {
        return _weights[index];
    }

    // --------------------------------------------------------------------- //
    //  Commit / reveal                                                      //
    // --------------------------------------------------------------------- //

    /// @notice Pay for a pull and record the commit block. One open commit at a time.
    /// @param payer Account that pays (must have approved this contract). Caller is the
    ///        committer; `payer` lets a relayer cover the cost but the commit belongs to
    ///        msg.sender.
    function commit(address payer) external {
        if (commits[msg.sender] != 0) revert CommitOpen();
        commits[msg.sender] = block.number;
        if (price > 0) {
            payToken.safeTransferFrom(payer, treasury, price);
        }
        emit Committed(msg.sender, block.number);
    }

    /// @notice Convenience overload: caller pays for their own commit.
    function commit() external {
        if (commits[msg.sender] != 0) revert CommitOpen();
        commits[msg.sender] = block.number;
        if (price > 0) {
            payToken.safeTransferFrom(msg.sender, treasury, price);
        }
        emit Committed(msg.sender, block.number);
    }

    /// @notice Reveal a committed pull: derive randomness from blockhash(commitBlock+1),
    ///         pick a rarity by weight, mint the NFT, and clear the commit.
    /// @dev Reverts if called in the same block as commit (TooEarly) or if the target
    ///      blockhash is no longer available — beyond the 256-block window (TooLate).
    function reveal() external returns (uint256 tokenId) {
        uint256 commitBlock = commits[msg.sender];
        if (commitBlock == 0) revert NoCommit();

        uint256 revealBlock = commitBlock + 1;
        if (block.number <= revealBlock) revert TooEarly();

        bytes32 bh = blockhash(revealBlock);
        if (bh == bytes32(0)) revert TooLate(); // outside the 256-block lookback window

        // Clear commit before minting (effects before interactions).
        delete commits[msg.sender];

        uint256 rarity = _pick(bh, msg.sender);

        // Pity: count consecutive non-rarest, force rarest at threshold, then reset.
        uint256 rarest = _weights.length - 1;
        if (pityThreshold > 0) {
            if (rarity == rarest) {
                pityCounter[msg.sender] = 0;
            } else {
                uint256 pc = pityCounter[msg.sender] + 1;
                if (pc >= pityThreshold) {
                    rarity = rarest;
                    pityCounter[msg.sender] = 0;
                } else {
                    pityCounter[msg.sender] = pc;
                }
            }
        }

        tokenId = _nextId++;
        rarityOf[tokenId] = rarity;
        _safeMint(msg.sender, tokenId);

        emit Revealed(msg.sender, tokenId, rarity);
    }

    /// @dev Weighted pick over [0, totalWeight). Uses the committed future blockhash
    ///      mixed with the user address so concurrent reveals in the same block differ.
    function _pick(bytes32 bh, address user) internal view returns (uint256) {
        uint256 roll = uint256(keccak256(abi.encodePacked(bh, user))) % totalWeight;
        uint256 cursor;
        uint256 len = _weights.length;
        for (uint256 i = 0; i < len; i++) {
            cursor += _weights[i];
            if (roll < cursor) {
                return i;
            }
        }
        // Unreachable: roll < totalWeight always lands in the loop.
        return len - 1;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
