// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IStalePriceOracle} from "../interfaces/IStalePriceOracle.sol";

/// @notice Test-only timestamped price source: lets tests drive a price and an explicit
///         `updatedAt` so the liquidation engine's staleness guard can be exercised. Also exposes
///         the plain `price(token)` getter so it can stand in for SimplePriceOracle where the base
///         CDP vault expects one.
contract MockStaleOracle is IStalePriceOracle {
    mapping(address => uint256) public price;
    mapping(address => uint256) public updatedAt;

    /// @notice Set the price for `token` and stamp it with the current block time.
    function setPrice(address token, uint256 p) external {
        price[token] = p;
        updatedAt[token] = block.timestamp;
    }

    /// @notice Set the price and an explicit `updatedAt` (to forge stale/fresh quotes).
    function setPriceAt(address token, uint256 p, uint256 ts) external {
        price[token] = p;
        updatedAt[token] = ts;
    }

    function priceWithTimestamp(address token) external view returns (uint256, uint256) {
        return (price[token], updatedAt[token]);
    }
}
