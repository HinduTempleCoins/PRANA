// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SoulboundToken
/// @notice A non-transferable ERC-721 for achievements / lore fragments.
///         Tokens can be minted by MINTER_ROLE and burned by their holder or an admin,
///         but never transferred between owners.
contract SoulboundToken is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 private _nextTokenId;

    mapping(uint256 => string) private _tokenURIs;

    error Soulbound();
    error NonexistentToken();
    error NotOwnerOrAdmin();

    constructor(string memory name_, string memory symbol_, address admin)
        ERC721(name_, symbol_)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint a new soulbound token to `to` with metadata at `uri`.
    /// @return tokenId The id of the newly minted token.
    function mint(address to, string memory uri)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 tokenId)
    {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _tokenURIs[tokenId] = uri;
    }

    /// @notice Burn `tokenId`. Callable by the token's owner or a DEFAULT_ADMIN_ROLE holder.
    function burn(uint256 tokenId) external {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert NonexistentToken();
        if (msg.sender != owner && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotOwnerOrAdmin();
        }
        _burn(tokenId);
        delete _tokenURIs[tokenId];
    }

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert NonexistentToken();
        return _tokenURIs[tokenId];
    }

    /// @dev Block all owner->owner transfers. Allow mint (from zero) and burn (to zero).
    ///      On mint `auth` is address(0); on owner-initiated transfer/burn `auth` is set.
    ///      Reverting when `auth != address(0)` and the token already has an owner blocks
    ///      any transfer between two non-zero addresses while still permitting burns,
    ///      which resolve to a zero destination inside `super._update`.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        // from != 0 -> token already owned (not a mint); to != 0 -> not a burn.
        if (from != address(0) && to != address(0)) {
            revert Soulbound();
        }
        return super._update(to, tokenId, auth);
    }

    /// @inheritdoc AccessControl
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
