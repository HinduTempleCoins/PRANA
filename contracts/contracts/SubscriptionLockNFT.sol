// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SubscriptionLockNFT — time-bound NFT membership keys (Unlock Protocol model)
/// @notice Pay `price` in an ERC-20 to mint a membership key (an NFT) valid for `period` seconds;
///         renew to extend. The key is a normal ERC-721 (transferable/tradeable). `isValid` gates
///         access. Payment goes to a treasury — distinct from the burn-for-access flavor (AccessGate).
contract SubscriptionLockNFT is ERC721 {
    using SafeERC20 for IERC20;

    IERC20 public immutable payToken;
    uint256 public immutable price;
    uint64 public immutable period;
    address public immutable treasury;

    uint256 private _nextId;
    mapping(uint256 => uint64) public expiryOf;

    event KeyPurchased(uint256 indexed id, address indexed to, uint64 expiry);
    event KeyRenewed(uint256 indexed id, uint64 expiry);

    constructor(IERC20 payToken_, uint256 price_, uint64 period_, address treasury_)
        ERC721("PRANA Membership", "PKEY")
    {
        require(address(payToken_) != address(0) && treasury_ != address(0), "zero");
        require(price_ > 0 && period_ > 0, "bad params");
        payToken = payToken_;
        price = price_;
        period = period_;
        treasury = treasury_;
    }

    function purchase(address to) external returns (uint256 id) {
        payToken.safeTransferFrom(msg.sender, treasury, price);
        id = _nextId++;
        _safeMint(to, id);
        expiryOf[id] = uint64(block.timestamp) + period;
        emit KeyPurchased(id, to, expiryOf[id]);
    }

    function renew(uint256 id) external {
        require(_ownerOf(id) != address(0), "no key");
        payToken.safeTransferFrom(msg.sender, treasury, price);
        uint64 base = expiryOf[id] > block.timestamp ? expiryOf[id] : uint64(block.timestamp);
        expiryOf[id] = base + period;
        emit KeyRenewed(id, expiryOf[id]);
    }

    function isValid(uint256 id) public view returns (bool) {
        return expiryOf[id] > block.timestamp;
    }

    function totalMinted() external view returns (uint256) {
        return _nextId;
    }
}
