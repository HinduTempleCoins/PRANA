// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IMonumentFragmentRegistry — collect a full set of soulbound fragments to reveal lore.
/// @notice External surface of {MonumentFragmentRegistry}: admins define (and seal) fragment sets,
///         each pinned to a soulbound ERC-721 fragment token and a list of required fragment ids;
///         a player who holds ALL fragments of a set claims a reveal (recording first-revealer and
///         a reveal count). Fragments are non-consumed (the soulbound token stays with the holder).
interface IMonumentFragmentRegistry {
    event SetDefined(uint256 indexed setId, address indexed token, uint256 fragmentCount, bytes32 contentRef);
    event SetSealed(uint256 indexed setId);
    event CorpusRevealed(address indexed player, uint256 indexed setId, bytes32 contentRef);

    function revealed(address player, uint256 setId) external view returns (bool);
    function revealCount(uint256 setId) external view returns (uint256);
    function firstRevealer(uint256 setId) external view returns (address);

    // --- admin ------------------------------------------------------------ //
    function defineSet(uint256 setId, address token, uint256[] calldata fragmentIds, bytes32 contentRef) external;
    function setContentRef(uint256 setId, bytes32 contentRef) external;
    function sealSet(uint256 setId) external;

    // --- player ----------------------------------------------------------- //
    function claimReveal(uint256 setId) external;

    // --- views ------------------------------------------------------------ //
    function canReveal(uint256 setId, address account) external view returns (bool);
    function setExists(uint256 setId) external view returns (bool);
    function isSealed(uint256 setId) external view returns (bool);
    function getSet(uint256 setId)
        external
        view
        returns (address token, uint256[] memory fragmentIds, bytes32 contentRef, bool sealed_);
    function fragmentsOf(uint256 setId) external view returns (uint256[] memory);
}
