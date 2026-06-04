// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal view of the creature collection this breeder composes with.
///      The breeder must hold MINTER_ROLE on the collection so `mintGenesis`
///      succeeds; ownership/cooldown checks read through `ownerOf` / `traitsOf`.
interface ICreatureNFT is IERC721 {
    function mintGenesis(address to) external returns (uint256 id);

    function traitsOf(uint256 tokenId) external view returns (uint256);
}

/// @dev Burnable ERC-20 used as the breed-fee sink.
interface IBurnableERC20 is IERC20 {
    function burnFrom(address account, uint256 amount) external;
}

/// @title CreatureBreeding
/// @notice Commit-reveal breeding sink for the CreatureNFT collection. A caller who
///         owns two parent creatures commits a breed (paying a fee in a burnable
///         ERC-20 that is permanently BURNED — a supply sink), then reveals one or
///         more blocks later. The child's packed traits are a deterministic per-nibble
///         gene-mix of the two parents, selected by a seed derived from a future
///         blockhash committed to before it was known (same scheme as GachaMint), so
///         neither the caller nor an operator can grind outcomes. Each parent is put on
///         a breeding cooldown at commit time.
/// @dev    This contract holds MINTER_ROLE on the CreatureNFT collection. The child NFT
///         is minted through the collection's role-gated `mintGenesis`; the gene-mixed
///         trait word is recorded here (keyed by child tokenId) so breeding does not
///         require modifying the collection. All traits are abstract numbers; no
///         real-world or third-party IP is referenced.
contract CreatureBreeding is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice The creature collection bred against (breeder holds its MINTER_ROLE).
    ICreatureNFT public immutable creatures;

    /// @notice Burnable ERC-20 charged (and burned) per breed.
    IBurnableERC20 public immutable feeToken;

    /// @notice Fee burned per breed, in feeToken base units.
    uint256 public immutable breedFee;

    /// @notice Minimum number of blocks a parent must wait between breeds.
    uint256 public immutable cooldownBlocks;

    struct Commitment {
        uint256 parent1;
        uint256 parent2;
        uint256 commitBlock;
        bool open;
    }

    /// @notice One open commitment per breeder.
    mapping(address => Commitment) public commitments;

    /// @notice Earliest block at which a given parent may be committed to breed again.
    mapping(uint256 => uint256) public breedReadyBlock;

    /// @notice Gene-mixed packed trait word recorded for each bred child tokenId.
    mapping(uint256 => uint256) public childTraits;

    event BreedCommitted(
        address indexed breeder,
        uint256 indexed parent1,
        uint256 indexed parent2,
        uint256 commitBlock
    );
    event BreedRevealed(
        address indexed breeder,
        uint256 indexed childId,
        uint256 parent1,
        uint256 parent2,
        uint256 traits
    );

    error SameParent();
    error NotParentOwner(uint256 tokenId);
    error ParentOnCooldown(uint256 tokenId);
    error CommitOpen();
    error NoCommit();
    error TooEarly();
    error TooLate();

    /// @param creatures_ The CreatureNFT collection (this contract must hold its MINTER_ROLE).
    /// @param feeToken_ Burnable ERC-20 charged per breed.
    /// @param breedFee_ Amount of feeToken burned per breed.
    /// @param cooldownBlocks_ Blocks a parent waits between breeds.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(
        ICreatureNFT creatures_,
        IBurnableERC20 feeToken_,
        uint256 breedFee_,
        uint256 cooldownBlocks_,
        address admin
    ) {
        creatures = creatures_;
        feeToken = feeToken_;
        breedFee = breedFee_;
        cooldownBlocks = cooldownBlocks_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /// @notice Commit a breed of two owned parents. Burns the breed fee, arms each
    ///         parent's cooldown, and records the commit block whose +1 blockhash will
    ///         seed the gene-mix at reveal. One open commit per breeder.
    /// @dev    The fee is burned via `burnFrom`, so the caller must have approved this
    ///         contract for `breedFee` of `feeToken` first.
    function commitBreed(uint256 parent1, uint256 parent2) external {
        if (parent1 == parent2) revert SameParent();
        if (commitments[msg.sender].open) revert CommitOpen();
        if (creatures.ownerOf(parent1) != msg.sender) revert NotParentOwner(parent1);
        if (creatures.ownerOf(parent2) != msg.sender) revert NotParentOwner(parent2);
        if (block.number < breedReadyBlock[parent1]) revert ParentOnCooldown(parent1);
        if (block.number < breedReadyBlock[parent2]) revert ParentOnCooldown(parent2);

        // Effects before the burn interaction.
        uint256 readyAt = block.number + cooldownBlocks;
        breedReadyBlock[parent1] = readyAt;
        breedReadyBlock[parent2] = readyAt;
        commitments[msg.sender] = Commitment({
            parent1: parent1,
            parent2: parent2,
            commitBlock: block.number,
            open: true
        });

        if (breedFee > 0) {
            feeToken.burnFrom(msg.sender, breedFee);
        }

        emit BreedCommitted(msg.sender, parent1, parent2, block.number);
    }

    /// @notice Reveal a committed breed: derive the seed from blockhash(commitBlock+1),
    ///         gene-mix the parents' trait words per nibble, mint the child to the
    ///         breeder, and record the child's traits. Clears the commit.
    /// @dev    Reverts TooEarly until the reveal block is mined, and TooLate once that
    ///         blockhash falls outside the 256-block lookback window. The caller must
    ///         still own both parents at reveal time.
    function revealBreed() external returns (uint256 childId) {
        Commitment memory c = commitments[msg.sender];
        if (!c.open) revert NoCommit();

        uint256 revealBlock = c.commitBlock + 1;
        if (block.number <= revealBlock) revert TooEarly();

        bytes32 bh = blockhash(revealBlock);
        if (bh == bytes32(0)) revert TooLate(); // outside the 256-block lookback window

        if (creatures.ownerOf(c.parent1) != msg.sender) revert NotParentOwner(c.parent1);
        if (creatures.ownerOf(c.parent2) != msg.sender) revert NotParentOwner(c.parent2);

        // Clear the commit before minting (effects before interactions).
        delete commitments[msg.sender];

        uint256 t1 = creatures.traitsOf(c.parent1);
        uint256 t2 = creatures.traitsOf(c.parent2);

        // Per-nibble selection seed: each of the 64 nibbles of the child's trait word is
        // taken from parent1 or parent2 depending on the corresponding seed bit. The seed
        // mixes the unknowable-at-commit blockhash with the parents and breeder so it
        // cannot be ground.
        uint256 seed = uint256(
            keccak256(abi.encodePacked(bh, c.parent1, c.parent2, t1, t2, msg.sender))
        );

        uint256 traits;
        for (uint256 i = 0; i < 64; i++) {
            uint256 shift = i * 4;
            uint256 nibble = ((seed >> i) & 1) == 1
                ? (t1 >> shift) & 0xf
                : (t2 >> shift) & 0xf;
            traits |= nibble << shift;
        }

        // Mint the child through the collection's role-gated path (we hold MINTER_ROLE),
        // then record the gene-mixed trait word here keyed by the new tokenId.
        childId = creatures.mintGenesis(msg.sender);
        childTraits[childId] = traits;

        emit BreedRevealed(msg.sender, childId, c.parent1, c.parent2, traits);
    }

    /// @notice Whether `tokenId` is currently off its breeding cooldown.
    function canBreed(uint256 tokenId) external view returns (bool) {
        return block.number >= breedReadyBlock[tokenId];
    }
}
