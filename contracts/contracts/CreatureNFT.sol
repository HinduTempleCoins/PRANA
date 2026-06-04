// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title CreatureNFT — breedable original-IP creature ERC-721
/// @notice Each token carries deterministically-derived packed `traits` (a uint256 holding
///         eight 32-bit generic attribute slots) and a `birthTime`. Genesis creatures are
///         minted by MINTER_ROLE with pseudo-random traits seeded from (tokenId, owner).
///         Any two creatures owned by the same caller can be bred — subject to a per-parent
///         cooldown — to produce a child whose traits are a per-nibble mix of its parents.
///         All traits are abstract numbers; no real-world or third-party IP is referenced.
contract CreatureNFT is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Minimum time a creature must wait between breeds.
    uint256 public constant BREED_COOLDOWN = 1 days;

    uint256 private _nextId;

    /// @notice Packed deterministic trait word for each token id.
    mapping(uint256 => uint256) private _traits;
    /// @notice Block timestamp at which each token was minted.
    mapping(uint256 => uint256) private _birthTime;
    /// @notice Earliest timestamp at which a given token may breed again.
    mapping(uint256 => uint256) private _breedReadyAt;

    event GenesisMinted(uint256 indexed tokenId, address indexed to, uint256 traits);
    event Bred(
        uint256 indexed childId,
        uint256 indexed parent1,
        uint256 indexed parent2,
        address to,
        uint256 traits
    );

    constructor(address admin) ERC721("PRANA Creature", "CRTR") {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint a generation-0 creature with deterministic pseudo-random traits.
    /// @dev Seed is keccak(tokenId, to) — deterministic and free of block-controlled inputs
    ///      such as prevrandao, so genesis traits are reproducible off-chain.
    function mintGenesis(address to) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        require(to != address(0), "to=0");
        id = _nextId++;
        uint256 t = uint256(keccak256(abi.encodePacked(id, to)));
        _traits[id] = t;
        _birthTime[id] = block.timestamp;
        _safeMint(to, id);
        emit GenesisMinted(id, to, t);
    }

    /// @notice Breed two creatures the caller owns into a new child creature.
    /// @dev Enforces a per-parent cooldown, mixes traits per nibble using a derived seed,
    ///      mints the child to the caller, and arms both parents' cooldowns.
    function breed(uint256 parent1, uint256 parent2) external returns (uint256 childId) {
        require(parent1 != parent2, "same parent");
        require(ownerOf(parent1) == msg.sender, "not owner p1");
        require(ownerOf(parent2) == msg.sender, "not owner p2");
        require(block.timestamp >= _breedReadyAt[parent1], "p1 cooldown");
        require(block.timestamp >= _breedReadyAt[parent2], "p2 cooldown");

        uint256 t1 = _traits[parent1];
        uint256 t2 = _traits[parent2];

        childId = _nextId++;

        // Per-nibble selection seed: each of the 64 nibbles of the child's trait word is
        // taken from either parent1 or parent2 depending on the corresponding seed bit.
        uint256 seed = uint256(
            keccak256(abi.encodePacked(parent1, parent2, t1, t2, childId, msg.sender))
        );

        uint256 childTraits;
        for (uint256 i = 0; i < 64; i++) {
            uint256 shift = i * 4;
            uint256 nibble = ((seed >> i) & 1) == 1
                ? (t1 >> shift) & 0xf
                : (t2 >> shift) & 0xf;
            childTraits |= nibble << shift;
        }

        _traits[childId] = childTraits;
        _birthTime[childId] = block.timestamp;

        uint256 readyAt = block.timestamp + BREED_COOLDOWN;
        _breedReadyAt[parent1] = readyAt;
        _breedReadyAt[parent2] = readyAt;

        _safeMint(msg.sender, childId);
        emit Bred(childId, parent1, parent2, msg.sender, childTraits);
    }

    /// @notice Packed deterministic trait word for `tokenId`.
    function traitsOf(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _traits[tokenId];
    }

    /// @notice Mint timestamp for `tokenId`.
    function birthTimeOf(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _birthTime[tokenId];
    }

    /// @notice Whether `tokenId` is currently off cooldown and able to breed.
    function canBreed(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return block.timestamp >= _breedReadyAt[tokenId];
    }

    /// @notice Total number of creatures ever minted (also the next id).
    function minted() external view returns (uint256) {
        return _nextId;
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
