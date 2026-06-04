// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title RoyaltyNFT
/// @notice Role-gated mintable ERC-721 with per-token URIs and EIP-2981 royalties.
contract RoyaltyNFT is ERC721, ERC721URIStorage, ERC2981, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 private _nextTokenId;

    /// @param name_ Collection name.
    /// @param symbol_ Collection symbol.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE and MINTER_ROLE.
    /// @param royaltyReceiver Default royalty receiver.
    /// @param feeNumerator Default royalty fee in basis points (e.g. 500 = 5%).
    constructor(
        string memory name_,
        string memory symbol_,
        address admin,
        address royaltyReceiver,
        uint96 feeNumerator
    ) ERC721(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _setDefaultRoyalty(royaltyReceiver, feeNumerator);
    }

    /// @notice Mint a new token with an auto-incremented id to `to`, setting its URI.
    /// @return tokenId The id of the newly minted token.
    function mint(address to, string memory uri) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Update the collection-wide default royalty.
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    /// @notice Set a royalty override for a specific token.
    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 feeNumerator)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setTokenRoyalty(tokenId, receiver, feeNumerator);
    }

    // --- Required overrides (OZ v5) ---

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage, ERC2981, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
