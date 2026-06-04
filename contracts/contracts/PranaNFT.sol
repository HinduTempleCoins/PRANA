// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PranaNFT — role-gated mintable ERC-721 with per-token URIs
/// @notice Generic NFT for an NFT-native wallet/gateway: game assets, collectibles,
///         and items that can serve as burn-mine inputs or (if liquid) collateral. Minting is
///         gated by MINTER_ROLE so a game/airdrop module mints; ids auto-increment from 0.
contract PranaNFT is ERC721, ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint256 private _nextId;

    constructor(address admin) ERC721("PRANA NFT", "PNFT") {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint a new token with metadata `uri` to `to`. Returns the new token id.
    function mint(address to, string calldata uri) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        id = _nextId++;
        _safeMint(to, id);
        _setTokenURI(id, uri);
    }

    /// @notice Total number of tokens ever minted (also the next id).
    function minted() external view returns (uint256) {
        return _nextId;
    }

    // ---- required overrides for ERC721URIStorage + AccessControl ----
    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage) returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
