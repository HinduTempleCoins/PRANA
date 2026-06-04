// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MutableStatNFT — cross-game persistence primitive (ERC-721 with mutable stats)
/// @notice Each token carries:
///           - an immutable `genome` field set at mint (a deterministic baseline that
///             composes alongside CreatureNFT-style packed traits without modifying it),
///           - a packed `Core` struct (level, xp, wear, equippedItem) that games mutate,
///           - an open per-token attribute store: key (bytes32) => value (uint256).
///         Any number of per-game contracts can be granted STAT_WRITER_ROLE to mutate a
///         token's stats; the chain is the single shared store, so progress persists across
///         every game that reads it. Reads are public; writes are role-gated.
/// @dev Holds NO game logic — it is pure storage + access control. The genome is fixed at
///      mint and never changes; everything else is mutable by STAT_WRITER_ROLE.
contract MutableStatNFT is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant STAT_WRITER_ROLE = keccak256("STAT_WRITER_ROLE");

    /// @notice Packed core stats every game understands. Kept narrow so a write touches one slot.
    struct Core {
        uint64 level;
        uint128 xp;
        uint32 wear;
        uint256 equippedItem;
    }

    uint256 private _nextId;

    /// @notice Immutable baseline set at mint; composable with external trait words.
    mapping(uint256 => uint256) private _genome;
    /// @notice Packed core stats per token.
    mapping(uint256 => Core) private _core;
    /// @notice Open attribute store: tokenId => key => value.
    mapping(uint256 => mapping(bytes32 => uint256)) private _stats;
    /// @notice Per-token metadata URI.
    mapping(uint256 => string) private _tokenURIs;

    event Minted(uint256 indexed tokenId, address indexed to, uint256 genome);
    event StatChanged(uint256 indexed tokenId, bytes32 indexed key, uint256 oldValue, uint256 newValue);
    event CoreChanged(uint256 indexed tokenId, uint64 level, uint128 xp, uint32 wear, uint256 equippedItem);

    error ZeroAddress();
    error NonexistentToken();
    error LengthMismatch();

    /// @param admin Receives DEFAULT_ADMIN_ROLE, MINTER_ROLE and STAT_WRITER_ROLE.
    constructor(string memory name_, string memory symbol_, address admin)
        ERC721(name_, symbol_)
    {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(STAT_WRITER_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                                mint                                   //
    // --------------------------------------------------------------------- //

    /// @notice Mint a new token to `to`, fixing its immutable `genome` and metadata `uri`.
    /// @return tokenId The id of the newly minted token.
    function mint(address to, uint256 genome, string calldata uri)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 tokenId)
    {
        if (to == address(0)) revert ZeroAddress();
        tokenId = _nextId++;
        _genome[tokenId] = genome;
        _tokenURIs[tokenId] = uri;
        _safeMint(to, tokenId);
        emit Minted(tokenId, to, genome);
    }

    // --------------------------------------------------------------------- //
    //                          writes (role-gated)                         //
    // --------------------------------------------------------------------- //

    /// @notice Set one attribute `key` to `value` on `tokenId`.
    function setStat(uint256 tokenId, bytes32 key, uint256 value)
        external
        onlyRole(STAT_WRITER_ROLE)
    {
        _requireExists(tokenId);
        _writeStat(tokenId, key, value);
    }

    /// @notice Set many attributes on `tokenId` in one call.
    function setStats(uint256 tokenId, bytes32[] calldata keys, uint256[] calldata values)
        external
        onlyRole(STAT_WRITER_ROLE)
    {
        _requireExists(tokenId);
        if (keys.length != values.length) revert LengthMismatch();
        for (uint256 i = 0; i < keys.length; i++) {
            _writeStat(tokenId, keys[i], values[i]);
        }
    }

    /// @notice Add `delta` to attribute `key` on `tokenId` (saturating-free; reverts on overflow).
    /// @return newValue The resulting stored value.
    function incrementStat(uint256 tokenId, bytes32 key, uint256 delta)
        external
        onlyRole(STAT_WRITER_ROLE)
        returns (uint256 newValue)
    {
        _requireExists(tokenId);
        uint256 old = _stats[tokenId][key];
        newValue = old + delta;
        _stats[tokenId][key] = newValue;
        emit StatChanged(tokenId, key, old, newValue);
    }

    /// @notice Overwrite the packed core stats of `tokenId`.
    function setCore(uint256 tokenId, Core calldata core)
        external
        onlyRole(STAT_WRITER_ROLE)
    {
        _requireExists(tokenId);
        _core[tokenId] = core;
        emit CoreChanged(tokenId, core.level, core.xp, core.wear, core.equippedItem);
    }

    // --------------------------------------------------------------------- //
    //                                reads                                  //
    // --------------------------------------------------------------------- //

    /// @notice Immutable baseline genome of `tokenId`.
    function genomeOf(uint256 tokenId) external view returns (uint256) {
        _requireExists(tokenId);
        return _genome[tokenId];
    }

    /// @notice Single attribute value (0 if never set). No existence check — unset == 0.
    function getStat(uint256 tokenId, bytes32 key) external view returns (uint256) {
        return _stats[tokenId][key];
    }

    /// @notice Batched read of attribute `keys` for `tokenId`.
    function getStats(uint256 tokenId, bytes32[] calldata keys)
        external
        view
        returns (uint256[] memory values)
    {
        values = new uint256[](keys.length);
        mapping(bytes32 => uint256) storage store = _stats[tokenId];
        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = store[keys[i]];
        }
    }

    /// @notice Packed core stats of `tokenId`.
    function getCore(uint256 tokenId) external view returns (Core memory) {
        return _core[tokenId];
    }

    /// @notice Total number of tokens ever minted (also the next id).
    function minted() external view returns (uint256) {
        return _nextId;
    }

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireExists(tokenId);
        return _tokenURIs[tokenId];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // --------------------------------------------------------------------- //
    //                              internal                                //
    // --------------------------------------------------------------------- //

    function _writeStat(uint256 tokenId, bytes32 key, uint256 value) private {
        uint256 old = _stats[tokenId][key];
        _stats[tokenId][key] = value;
        emit StatChanged(tokenId, key, old, value);
    }

    function _requireExists(uint256 tokenId) private view {
        if (_ownerOf(tokenId) == address(0)) revert NonexistentToken();
    }
}
