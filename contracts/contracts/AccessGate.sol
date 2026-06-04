// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title AccessGate — burn-for-access (subscription / Bond model)
/// @notice Burn a token to extend time-based access at a fixed price-per-second. Access stacks:
///         buying while still active extends from the current expiry, otherwise from now. The
///         burn is irreversible (disclose to users). Caller must approve this contract (burnFrom).
contract AccessGate {
    ERC20Burnable public immutable token;
    uint256 public immutable pricePerSecond; // tokens burned per second of access

    mapping(address => uint256) public accessUntil; // unix expiry per user

    event AccessPurchased(address indexed user, uint256 burned, uint256 secondsAdded, uint256 newExpiry);

    constructor(ERC20Burnable token_, uint256 pricePerSecond_) {
        require(address(token_) != address(0), "token=0");
        require(pricePerSecond_ > 0, "price=0");
        token = token_;
        pricePerSecond = pricePerSecond_;
    }

    /// @notice How many seconds `amount` tokens would buy (floor).
    function quoteSeconds(uint256 amount) public view returns (uint256) {
        return amount / pricePerSecond;
    }

    /// @notice Burn up to `amount` (only the exact cost of whole seconds) to extend access.
    function buy(uint256 amount) external returns (uint256 newExpiry) {
        uint256 secondsBought = amount / pricePerSecond;
        require(secondsBought > 0, "too little");
        uint256 cost = secondsBought * pricePerSecond;

        token.burnFrom(msg.sender, cost);

        uint256 base = accessUntil[msg.sender] > block.timestamp ? accessUntil[msg.sender] : block.timestamp;
        newExpiry = base + secondsBought;
        accessUntil[msg.sender] = newExpiry;

        emit AccessPurchased(msg.sender, cost, secondsBought, newExpiry);
    }

    /// @notice True if `user` currently has active access.
    function hasAccess(address user) external view returns (bool) {
        return accessUntil[user] > block.timestamp;
    }
}
