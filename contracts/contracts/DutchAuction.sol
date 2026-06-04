// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

/// @title DutchAuction — linear declining-price auction for a single ERC-721, paid in an ERC-20
/// @notice The seller escrows one NFT and sets a start price, an end (floor) price, and a
///         duration. The asking price declines linearly from startPrice to endPrice across the
///         duration and then stays flat at endPrice. The first buyer to `buy()` pays the
///         current price (pulled in the pay token, straight to the seller) and receives the NFT.
///         The seller may `cancel()` and reclaim the NFT any time before a sale.
/// @dev Single-shot: one auction per deployment, started once. Uses SafeERC20 for the pay token
///      so non-standard ERC-20s (no/odd return values) are handled correctly.
contract DutchAuction is ERC721Holder {
    using SafeERC20 for IERC20;

    enum State {
        Pending, // not yet started
        Live,    // NFT escrowed, accepting buys
        Sold,    // sold to a buyer
        Cancelled // reclaimed by the seller
    }

    address public seller;
    IERC721 public nft;
    uint256 public tokenId;
    IERC20 public payToken;
    uint256 public startPrice;
    uint256 public endPrice;
    uint64 public startTime;
    uint64 public duration;
    State public state;

    event Started(
        address indexed seller,
        address indexed nft,
        uint256 indexed tokenId,
        address payToken,
        uint256 startPrice,
        uint256 endPrice,
        uint64 startTime,
        uint64 duration
    );
    event Bought(address indexed buyer, uint256 price);
    event Cancelled(address indexed seller);

    /// @notice Escrow the NFT and open the auction. Callable once.
    /// @param nft_ The ERC-721 collection being auctioned.
    /// @param tokenId_ The token id within `nft_` to sell.
    /// @param payToken_ The ERC-20 the buyer pays in.
    /// @param startPrice_ Asking price at startTime (the highest price).
    /// @param endPrice_ Floor price reached at startTime+duration and held thereafter.
    /// @param duration_ Seconds over which the price declines (must be > 0).
    function start(
        IERC721 nft_,
        uint256 tokenId_,
        IERC20 payToken_,
        uint256 startPrice_,
        uint256 endPrice_,
        uint64 duration_
    ) external {
        require(state == State.Pending, "already started");
        require(address(nft_) != address(0), "nft=0");
        require(address(payToken_) != address(0), "payToken=0");
        require(duration_ > 0, "duration=0");
        require(startPrice_ >= endPrice_, "start<end");

        seller = msg.sender;
        nft = nft_;
        tokenId = tokenId_;
        payToken = payToken_;
        startPrice = startPrice_;
        endPrice = endPrice_;
        startTime = uint64(block.timestamp);
        duration = duration_;
        state = State.Live;

        // Escrow the NFT (seller must have approved this contract).
        nft_.safeTransferFrom(msg.sender, address(this), tokenId_);

        emit Started(msg.sender, address(nft_), tokenId_, address(payToken_), startPrice_, endPrice_, startTime, duration_);
    }

    /// @notice The current asking price. Declines linearly over `duration`, then floors at `endPrice`.
    function currentPrice() public view returns (uint256) {
        require(state == State.Live, "not live");
        uint256 elapsed = block.timestamp - startTime;
        if (elapsed >= duration) {
            return endPrice;
        }
        // startPrice - (startPrice - endPrice) * elapsed / duration
        uint256 drop = ((startPrice - endPrice) * elapsed) / duration;
        return startPrice - drop;
    }

    /// @notice Buy the NFT at the current price. Pulls `currentPrice()` of the pay token from the
    ///         caller straight to the seller and transfers the NFT to the caller.
    function buy() external {
        require(state == State.Live, "not live");
        uint256 price = currentPrice();
        state = State.Sold;

        payToken.safeTransferFrom(msg.sender, seller, price);
        nft.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Bought(msg.sender, price);
    }

    /// @notice Cancel the auction before a sale and return the NFT to the seller.
    function cancel() external {
        require(state == State.Live, "not live");
        require(msg.sender == seller, "not seller");
        state = State.Cancelled;

        nft.safeTransferFrom(address(this), seller, tokenId);

        emit Cancelled(seller);
    }
}
