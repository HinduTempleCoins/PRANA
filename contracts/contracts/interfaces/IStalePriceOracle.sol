// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IStalePriceOracle — price source that also reports its last-update timestamp.
/// @notice The base SimplePriceOracle exposes only `price(token)` with no freshness signal, which
///         means a frozen feed can silently drive liquidations at a wrong price (the staleness gap
///         flagged in the threat model). A liquidation engine must instead read through this
///         interface, which returns both the price (scaled 1e18) and the `updatedAt` timestamp, so
///         the engine can reject any quote older than its configured `maxPriceAge`.
interface IStalePriceOracle {
    /// @return price Token price scaled to 1e18 (in debt/quote units).
    /// @return updatedAt Unix timestamp of the last price write.
    function priceWithTimestamp(address token) external view returns (uint256 price, uint256 updatedAt);
}
