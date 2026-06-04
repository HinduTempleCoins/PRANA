// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {ERC1155Burnable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ItemRegistry
/// @notice Canonical ERC-1155 for all fungible/semi-fungible game items. Item ids are
///         partitioned into documented ranges by category, and minting in each range is
///         gated by its own minter role so a compromised "seed dispenser" backend can never
///         mint cosmetics, and vice-versa. Supply is tracked per id (ERC1155Supply).
/// @dev ID-RANGE CONVENTION (inclusive):
///        seeds        :     1 .. 9_999      (SEED_MINTER_ROLE)
///        resources    : 10_000 .. 19_999    (RESOURCE_MINTER_ROLE)
///        consumables  : 20_000 .. 29_999    (CONSUMABLE_MINTER_ROLE)
///        cosmetics    : 30_000 .. type(uint256).max (COSMETIC_MINTER_ROLE)
///      Id 0 is reserved/invalid. Metadata follows the ERC-1155 `{id}` substitution
///      convention: `uri(id)` returns the base URI with the lowercase hex-padded id
///      substituted by the client (the standard "{id}.json" pattern).
contract ItemRegistry is ERC1155, ERC1155Supply, ERC1155Burnable, AccessControl {
    bytes32 public constant SEED_MINTER_ROLE = keccak256("SEED_MINTER_ROLE");
    bytes32 public constant RESOURCE_MINTER_ROLE = keccak256("RESOURCE_MINTER_ROLE");
    bytes32 public constant CONSUMABLE_MINTER_ROLE = keccak256("CONSUMABLE_MINTER_ROLE");
    bytes32 public constant COSMETIC_MINTER_ROLE = keccak256("COSMETIC_MINTER_ROLE");
    bytes32 public constant URI_SETTER_ROLE = keccak256("URI_SETTER_ROLE");

    // Inclusive range bounds.
    uint256 public constant SEED_MIN = 1;
    uint256 public constant SEED_MAX = 9_999;
    uint256 public constant RESOURCE_MIN = 10_000;
    uint256 public constant RESOURCE_MAX = 19_999;
    uint256 public constant CONSUMABLE_MIN = 20_000;
    uint256 public constant CONSUMABLE_MAX = 29_999;
    uint256 public constant COSMETIC_MIN = 30_000;

    /// @notice Item category, mirroring the id-range partition.
    enum Category {
        Invalid,
        Seed,
        Resource,
        Consumable,
        Cosmetic
    }

    event ItemMinted(address indexed to, uint256 indexed id, uint256 amount, Category category);
    event BaseURIUpdated(string newUri);

    error InvalidId(uint256 id);
    error WrongRange(uint256 id, Category expected);
    error LengthMismatch();

    /// @param baseURI The ERC-1155 base URI (e.g. "https://prana.example/item/{id}.json").
    /// @param admin   Address granted DEFAULT_ADMIN_ROLE, URI_SETTER_ROLE and every minter role.
    constructor(string memory baseURI, address admin) ERC1155(baseURI) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(URI_SETTER_ROLE, admin);
        _grantRole(SEED_MINTER_ROLE, admin);
        _grantRole(RESOURCE_MINTER_ROLE, admin);
        _grantRole(CONSUMABLE_MINTER_ROLE, admin);
        _grantRole(COSMETIC_MINTER_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //  Category helpers                                                     //
    // --------------------------------------------------------------------- //

    /// @notice The category an id falls into per the range convention.
    function categoryOf(uint256 id) public pure returns (Category) {
        if (id >= SEED_MIN && id <= SEED_MAX) return Category.Seed;
        if (id >= RESOURCE_MIN && id <= RESOURCE_MAX) return Category.Resource;
        if (id >= CONSUMABLE_MIN && id <= CONSUMABLE_MAX) return Category.Consumable;
        if (id >= COSMETIC_MIN) return Category.Cosmetic;
        return Category.Invalid; // id == 0
    }

    // --------------------------------------------------------------------- //
    //  Range-gated single mints                                             //
    // --------------------------------------------------------------------- //

    /// @notice Mint a seed item (id in [SEED_MIN, SEED_MAX]).
    function mintSeed(address to, uint256 id, uint256 amount, bytes calldata data)
        external
        onlyRole(SEED_MINTER_ROLE)
    {
        if (categoryOf(id) != Category.Seed) revert WrongRange(id, Category.Seed);
        _mint(to, id, amount, data);
        emit ItemMinted(to, id, amount, Category.Seed);
    }

    /// @notice Mint a resource item (id in [RESOURCE_MIN, RESOURCE_MAX]).
    function mintResource(address to, uint256 id, uint256 amount, bytes calldata data)
        external
        onlyRole(RESOURCE_MINTER_ROLE)
    {
        if (categoryOf(id) != Category.Resource) revert WrongRange(id, Category.Resource);
        _mint(to, id, amount, data);
        emit ItemMinted(to, id, amount, Category.Resource);
    }

    /// @notice Mint a consumable item (id in [CONSUMABLE_MIN, CONSUMABLE_MAX]).
    function mintConsumable(address to, uint256 id, uint256 amount, bytes calldata data)
        external
        onlyRole(CONSUMABLE_MINTER_ROLE)
    {
        if (categoryOf(id) != Category.Consumable) revert WrongRange(id, Category.Consumable);
        _mint(to, id, amount, data);
        emit ItemMinted(to, id, amount, Category.Consumable);
    }

    /// @notice Mint a cosmetic item (id >= COSMETIC_MIN).
    function mintCosmetic(address to, uint256 id, uint256 amount, bytes calldata data)
        external
        onlyRole(COSMETIC_MINTER_ROLE)
    {
        if (categoryOf(id) != Category.Cosmetic) revert WrongRange(id, Category.Cosmetic);
        _mint(to, id, amount, data);
        emit ItemMinted(to, id, amount, Category.Cosmetic);
    }

    // --------------------------------------------------------------------- //
    //  Batch mint                                                           //
    // --------------------------------------------------------------------- //

    /// @notice Batch-mint many ids to one recipient. Each id is range-checked and the caller
    ///         must hold the minter role for *every* id's category.
    /// @dev Rejects id 0 (Invalid). Roles are checked per-id so a batch cannot be used to
    ///      bypass the per-range gating.
    function mintBatch(
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        if (ids.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < ids.length; i++) {
            Category cat = categoryOf(ids[i]);
            if (cat == Category.Invalid) revert InvalidId(ids[i]);
            _checkRole(_minterRoleFor(cat));
            emit ItemMinted(to, ids[i], amounts[i], cat);
        }
        _mintBatch(to, ids, amounts, data);
    }

    /// @dev The minter role guarding a given category.
    function _minterRoleFor(Category cat) internal pure returns (bytes32) {
        if (cat == Category.Seed) return SEED_MINTER_ROLE;
        if (cat == Category.Resource) return RESOURCE_MINTER_ROLE;
        if (cat == Category.Consumable) return CONSUMABLE_MINTER_ROLE;
        return COSMETIC_MINTER_ROLE; // Cosmetic (Invalid handled by caller)
    }

    // --------------------------------------------------------------------- //
    //  Metadata                                                             //
    // --------------------------------------------------------------------- //

    /// @notice Update the base URI used for all item metadata.
    function setURI(string calldata newUri) external onlyRole(URI_SETTER_ROLE) {
        _setURI(newUri);
        emit BaseURIUpdated(newUri);
    }

    // --------------------------------------------------------------------- //
    //  Required overrides                                                   //
    // --------------------------------------------------------------------- //

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Supply) {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
