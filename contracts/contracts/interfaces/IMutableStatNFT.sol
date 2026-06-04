// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IMutableStatNFT — a game-agnostic NFT whose stats mutate under role-gated writers.
/// @notice External surface of {MutableStatNFT}: an immutable `genome` set at mint, a packed
///         {Core} stat block, and an open `bytes32 key => uint256` attribute store. Reads are
///         public; writes are gated to MINTER_ROLE / STAT_WRITER_ROLE on the implementation.
/// @dev Extends the standard ERC-721 surface (ownerOf/transfer/etc.) on the implementation; this
///      interface declares only the stat-specific additions.
interface IMutableStatNFT {
    struct Core {
        uint64 level;
        uint128 xp;
        uint32 wear;
        uint256 equippedItem;
    }

    event Minted(uint256 indexed tokenId, address indexed to, uint256 genome);
    event StatChanged(uint256 indexed tokenId, bytes32 indexed key, uint256 oldValue, uint256 newValue);
    event CoreChanged(uint256 indexed tokenId, uint64 level, uint128 xp, uint32 wear, uint256 equippedItem);

    // --- mutators (role-gated on the implementation) ---------------------- //
    function mint(address to, uint256 genome, string calldata uri) external returns (uint256 tokenId);
    function setStat(uint256 tokenId, bytes32 key, uint256 value) external;
    function setStats(uint256 tokenId, bytes32[] calldata keys, uint256[] calldata values) external;
    function incrementStat(uint256 tokenId, bytes32 key, uint256 delta) external returns (uint256 newValue);
    function setCore(uint256 tokenId, Core calldata core) external;

    // --- views ------------------------------------------------------------ //
    function genomeOf(uint256 tokenId) external view returns (uint256);
    function getStat(uint256 tokenId, bytes32 key) external view returns (uint256);
    function getStats(uint256 tokenId, bytes32[] calldata keys) external view returns (uint256[] memory values);
    function getCore(uint256 tokenId) external view returns (Core memory);
    function minted() external view returns (uint256);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}
