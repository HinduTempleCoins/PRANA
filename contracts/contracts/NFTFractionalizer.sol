// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FractionalVault — an ERC-20 representing fractional ownership of one escrowed ERC-721
/// @notice Each vault escrows a single NFT and mints a fixed supply of `totalShares` fractional
///         tokens to the depositor. A holder of 100% of the shares can `redeem()` to burn the whole
///         supply and reclaim the underlying NFT. The shares are ordinary, transferable ERC-20s.
/// @dev    The NFT is forwarded into the vault by the factory immediately after deploy, so the vault
///         must accept ERC-721 transfers (ERC721Holder). Minting happens in the constructor.
contract FractionalVault is ERC20, ERC721Holder {
    IERC721 public immutable nft;
    uint256 public immutable tokenId;
    uint256 public immutable totalShares;
    address public immutable depositor;

    /// @param _nft       the ERC-721 collection being fractionalized
    /// @param _tokenId   the specific token id this vault holds
    /// @param _shares    total fractional supply minted to `_depositor` (must be > 0)
    /// @param _depositor the account that receives the fractional shares
    /// @param _name      ERC-20 name of the fractional token
    /// @param _symbol    ERC-20 symbol of the fractional token
    constructor(
        IERC721 _nft,
        uint256 _tokenId,
        uint256 _shares,
        address _depositor,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        require(_shares > 0, "shares=0");
        require(_depositor != address(0), "depositor=0");
        nft = _nft;
        tokenId = _tokenId;
        totalShares = _shares;
        depositor = _depositor;
        _mint(_depositor, _shares);
    }

    /// @notice Burn 100% of the share supply and reclaim the underlying NFT.
    /// @dev    Requires the caller to hold the entire `totalShares` supply; the full supply being
    ///         concentrated in one account is the precondition for un-fractionalizing.
    function redeem() external {
        require(totalSupply() == totalShares, "already redeemed");
        require(balanceOf(msg.sender) == totalShares, "need 100% of shares");

        _burn(msg.sender, totalShares);
        nft.safeTransferFrom(address(this), msg.sender, tokenId);
    }
}

/// @title NFTFractionalizer — factory that locks an ERC-721 and issues fungible fractional shares
/// @notice `fractionalize` pulls the caller's NFT, deploys a fresh {FractionalVault} (one NFT per
///         vault), forwards the NFT into it, and the vault mints `shares` ERC-20 tokens to the
///         caller. Holding 100% of a vault's shares lets that holder redeem the underlying NFT.
/// @dev    The depositor approves THIS factory (a stable, known address) for the token — either
///         `approve(fractionalizer, tokenId)` or `setApprovalForAll(fractionalizer, true)` — which
///         sidesteps the chicken-and-egg of approving a not-yet-deployed vault. The factory is an
///         ERC721Holder only transiently (it never keeps custody).
contract NFTFractionalizer is ERC721Holder {
    /// @notice All vaults deployed by this factory, in creation order.
    address[] public vaults;

    event Fractionalized(
        address indexed vault,
        address indexed depositor,
        address indexed nft,
        uint256 tokenId,
        uint256 shares
    );

    /// @notice Lock `tokenId` of `nft` and mint `shares` fractional ERC-20 tokens to the caller.
    /// @param nft     the ERC-721 collection
    /// @param tokenId the token id to escrow (caller must own it and have approved this factory)
    /// @param shares  total fractional supply to mint to the caller (must be > 0)
    /// @param name    ERC-20 name of the fractional token
    /// @param symbol  ERC-20 symbol of the fractional token
    /// @return vault  address of the newly deployed {FractionalVault} now holding the NFT.
    function fractionalize(
        IERC721 nft,
        uint256 tokenId,
        uint256 shares,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        // Deploy the vault first (it mints shares to the caller), then move the NFT into it.
        FractionalVault v = new FractionalVault(nft, tokenId, shares, msg.sender, name, symbol);
        vault = address(v);

        // Pull the NFT from the caller (who approved this factory) straight into the vault.
        nft.safeTransferFrom(msg.sender, vault, tokenId);

        vaults.push(vault);
        emit Fractionalized(vault, msg.sender, address(nft), tokenId, shares);
    }

    /// @notice Number of vaults this factory has created.
    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
