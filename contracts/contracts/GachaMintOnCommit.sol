// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WeightedRandomDraw} from "./lib/WeightedRandomDraw.sol";

/// @title GachaMintOnCommit
/// @notice Hardened commit-reveal gacha that mints an ERC-721 of a *disclosed* rarity.
/// @dev    This is a hardened sibling of GachaMint (which it does NOT modify). The original
///         seeds purely from a future blockhash; a miner who is also the committer can grind
///         which block their reveal lands in, and an ordinary user can wait to reveal only on
///         a favourable blockhash. This version closes both holes by binding the seed to a
///         user-chosen salt that is *committed as a hash* up front:
///           - commit(saltHash) records block.number and keccak256(salt) and escrows the fee;
///           - reveal(salt) requires keccak256(salt) == the committed hash, then seeds from
///             blockhash(commitBlock+1) MIXED with the committer and the now-revealed salt.
///         Because the salt is fixed (hash-committed) before the blockhash is known, and the
///         blockhash is fixed before the salt is revealed, neither party can search the seed:
///         a colluding miner cannot grind blockhashes against an unknown salt, and the user
///         cannot pick a salt against an unknown blockhash. See the grinding note in the
///         project notes for the full argument. Rarity is drawn via {WeightedRandomDraw} over
///         a disclosed weight table (no hidden odds). The escrowed fee is forwarded to the
///         treasury on a successful reveal and refunded if the commit expires unrevealed.
contract GachaMintOnCommit is ERC721, AccessControl {
    using SafeERC20 for IERC20;
    using WeightedRandomDraw for uint256[];

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Number of blocks after the commit block before a commit can no longer be
    ///         revealed (because blockhash(commitBlock+1) leaves the 256-block lookback).
    ///         The reveal target is commitBlock+1, so the usable window is until
    ///         block.number <= commitBlock + 256.
    uint256 public constant EXPIRY_BLOCKS = 256;

    /// @notice The ERC-20 charged per pull.
    IERC20 public immutable payToken;

    /// @notice Price (in payToken base units) charged on `commit` and escrowed by this
    ///         contract until reveal (forwarded to treasury) or expiry refund.
    uint256 public immutable price;

    /// @notice Where collected payment is forwarded on a successful reveal.
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

    struct Commitment {
        uint256 commitBlock; // block.number at commit (0 = none open)
        uint256 escrow;      // payToken units held for this commit
        bytes32 saltHash;    // keccak256(abi.encodePacked(salt)) supplied at commit
    }

    /// @notice One open commit at a time per user.
    mapping(address => Commitment) public commitments;

    /// @notice Consecutive non-rarest reveals per user (for pity).
    mapping(address => uint256) public pityCounter;

    /// @notice Rarity assigned to each minted tokenId.
    mapping(uint256 => uint256) public rarityOf;

    uint256 private _nextId;

    event Committed(address indexed user, uint256 commitBlock, bytes32 saltHash);
    event Revealed(address indexed user, uint256 indexed tokenId, uint256 rarityIndex);
    event Refunded(address indexed user, uint256 amount);

    error LengthMismatch();
    error NoRarities();
    error ZeroWeight();
    error CommitOpen();
    error NoCommit();
    error TooEarly();
    error TooLate();
    error NotExpired();
    error BadSalt();
    error ZeroSaltHash();

    /// @param name_ ERC-721 collection name.
    /// @param symbol_ ERC-721 collection symbol.
    /// @param payToken_ ERC-20 used to pay for pulls.
    /// @param price_ Cost per pull in payToken base units.
    /// @param treasury_ Recipient of collected payment on successful reveal.
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

    /// @notice Helper to compute the salt hash a caller must pass to {commit}. Pure; callers
    ///         can also compute this off-chain. Keep `salt` secret until {reveal}.
    function saltHashOf(bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt));
    }

    // --------------------------------------------------------------------- //
    //  Commit / reveal                                                      //
    // --------------------------------------------------------------------- //

    /// @notice Pay for a pull, escrow the fee, and record the commit block + salt hash.
    ///         One open commit at a time.
    /// @param saltHash keccak256(abi.encodePacked(salt)) for a secret `salt` only the caller
    ///        knows. The same `salt` must be supplied to {reveal}. Must be non-zero.
    /// @param payer Account that pays (must have approved this contract). Caller is the
    ///        committer; `payer` lets a relayer cover the cost but the commit belongs to
    ///        msg.sender.
    function commit(bytes32 saltHash, address payer) external {
        _open(saltHash, payer);
    }

    /// @notice Convenience overload: caller pays for their own commit.
    function commit(bytes32 saltHash) external {
        _open(saltHash, msg.sender);
    }

    /// @dev Shared commit logic. Escrows `price` into this contract (refundable on expiry,
    ///      forwarded to treasury on reveal).
    function _open(bytes32 saltHash, address payer) internal {
        if (saltHash == bytes32(0)) revert ZeroSaltHash();
        if (commitments[msg.sender].commitBlock != 0) revert CommitOpen();

        commitments[msg.sender] = Commitment({
            commitBlock: block.number,
            escrow: price,
            saltHash: saltHash
        });

        if (price > 0) {
            payToken.safeTransferFrom(payer, address(this), price);
        }
        emit Committed(msg.sender, block.number, saltHash);
    }

    /// @notice Reveal a committed pull. Verifies the salt against the committed hash, derives
    ///         randomness from blockhash(commitBlock+1) mixed with the committer and the
    ///         revealed salt, picks a rarity by weight, mints the NFT, forwards the escrowed
    ///         fee to the treasury, and clears the commit.
    /// @param salt The secret pre-image whose keccak256 was supplied to {commit}.
    /// @dev    Reverts TooEarly until the reveal block is mined, TooLate once that blockhash
    ///         falls outside the 256-block lookback window (use {refundExpired} then), and
    ///         BadSalt if the salt does not match the committed hash.
    function reveal(bytes32 salt) external returns (uint256 tokenId) {
        Commitment memory c = commitments[msg.sender];
        if (c.commitBlock == 0) revert NoCommit();
        if (keccak256(abi.encodePacked(salt)) != c.saltHash) revert BadSalt();

        uint256 revealBlock = c.commitBlock + 1;
        if (block.number <= revealBlock) revert TooEarly();

        bytes32 bh = blockhash(revealBlock);
        if (bh == bytes32(0)) revert TooLate(); // outside the 256-block lookback window

        // Effects before interactions: clear the commit first.
        delete commitments[msg.sender];

        uint256 rarity = _resolveRarity(bh, salt);

        tokenId = _nextId++;
        rarityOf[tokenId] = rarity;
        _safeMint(msg.sender, tokenId);

        // Forward the escrowed fee now that the pull resolved.
        if (c.escrow > 0) {
            payToken.safeTransfer(treasury, c.escrow);
        }

        emit Revealed(msg.sender, tokenId, rarity);
    }

    /// @notice Refund an expired (unrevealable) commit's escrow back to the committer and
    ///         clear it, so a fresh commit can be opened.
    /// @dev    Callable once blockhash(commitBlock+1) has left the lookback window, i.e.
    ///         block.number > commitBlock + EXPIRY_BLOCKS. The escrow returns to msg.sender
    ///         (the committer), not the original payer.
    function refundExpired() external returns (uint256 amount) {
        Commitment memory c = commitments[msg.sender];
        if (c.commitBlock == 0) revert NoCommit();
        if (block.number <= c.commitBlock + EXPIRY_BLOCKS) revert NotExpired();

        delete commitments[msg.sender];

        amount = c.escrow;
        if (amount > 0) {
            payToken.safeTransfer(msg.sender, amount);
        }
        emit Refunded(msg.sender, amount);
    }

    /// @notice Whether the caller's open commit (if any) is past its reveal window and must
    ///         be refunded rather than revealed.
    function isExpired(address user) external view returns (bool) {
        uint256 cb = commitments[user].commitBlock;
        if (cb == 0) return false;
        return block.number > cb + EXPIRY_BLOCKS;
    }

    /// @dev Derive the seed from the unknowable-at-commit blockhash mixed with the committer
    ///      and the now-revealed salt, then draw a rarity. Applies pity afterwards.
    function _resolveRarity(bytes32 bh, bytes32 salt) internal returns (uint256 rarity) {
        uint256 entropy = uint256(keccak256(abi.encodePacked(bh, msg.sender, salt)));
        rarity = _weights.draw(entropy);

        if (pityThreshold > 0) {
            uint256 rarest = _weights.length - 1;
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
