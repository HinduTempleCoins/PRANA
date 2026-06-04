// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

/// @title RoyaltyMarketplace
/// @notice Fixed-price ERC-721 sales settled in an ERC-20. The NFT is escrowed in the
///         marketplace on listing. On purchase, if the NFT supports EIP-2981 the royalty
///         receiver is paid their cut and the seller receives the remainder.
contract RoyaltyMarketplace is ERC721Holder {
    using SafeERC20 for IERC20;

    struct Listing {
        address seller;
        IERC721 nft;
        uint256 tokenId;
        IERC20 payToken;
        uint256 price;
        bool active;
    }

    uint256 public nextListingId;
    mapping(uint256 => Listing) public listings;

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        address payToken,
        uint256 price
    );
    event Purchased(
        uint256 indexed listingId,
        address indexed buyer,
        address royaltyReceiver,
        uint256 royaltyAmount,
        uint256 sellerProceeds
    );
    event Cancelled(uint256 indexed listingId);

    /// @notice List an ERC-721 for a fixed price. Escrows the NFT into this contract.
    /// @dev Caller must own `tokenId` and have approved this marketplace to transfer it.
    /// @return listingId The id of the newly created listing.
    function list(IERC721 nft, uint256 tokenId, IERC20 payToken, uint256 price)
        external
        returns (uint256 listingId)
    {
        require(price > 0, "price=0");
        require(address(payToken) != address(0), "payToken=0");

        // Escrow the NFT (reverts unless caller is owner/approved).
        nft.transferFrom(msg.sender, address(this), tokenId);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nft: nft,
            tokenId: tokenId,
            payToken: payToken,
            price: price,
            active: true
        });

        emit Listed(listingId, msg.sender, address(nft), tokenId, address(payToken), price);
    }

    /// @notice Buy a listed NFT. Pulls `price` of the pay token from the buyer, pays any
    ///         EIP-2981 royalty to the receiver, the remainder to the seller, then delivers
    ///         the NFT to the buyer.
    function buy(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "inactive");

        l.active = false;

        IERC20 payToken = l.payToken;
        uint256 price = l.price;

        // Pull full payment from buyer into escrow.
        payToken.safeTransferFrom(msg.sender, address(this), price);

        (address royaltyReceiver, uint256 royaltyAmount) = _royaltyInfo(l.nft, l.tokenId, price);

        uint256 sellerProceeds = price;
        if (royaltyReceiver != address(0) && royaltyAmount > 0 && royaltyAmount <= price) {
            sellerProceeds = price - royaltyAmount;
            payToken.safeTransfer(royaltyReceiver, royaltyAmount);
        } else {
            royaltyReceiver = address(0);
            royaltyAmount = 0;
        }

        payToken.safeTransfer(l.seller, sellerProceeds);

        // Deliver the escrowed NFT to the buyer.
        l.nft.safeTransferFrom(address(this), msg.sender, l.tokenId);

        emit Purchased(listingId, msg.sender, royaltyReceiver, royaltyAmount, sellerProceeds);
    }

    /// @notice Cancel an active listing and return the escrowed NFT to the seller.
    function cancel(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "inactive");
        require(msg.sender == l.seller, "not seller");

        l.active = false;
        l.nft.safeTransferFrom(address(this), l.seller, l.tokenId);

        emit Cancelled(listingId);
    }

    /// @dev Safely query EIP-2981 royalty info; returns (0,0) for non-royalty NFTs.
    function _royaltyInfo(IERC721 nft, uint256 tokenId, uint256 salePrice)
        internal
        view
        returns (address receiver, uint256 amount)
    {
        try IERC2981(address(nft)).royaltyInfo(tokenId, salePrice) returns (
            address r,
            uint256 a
        ) {
            return (r, a);
        } catch {
            return (address(0), 0);
        }
    }
}
