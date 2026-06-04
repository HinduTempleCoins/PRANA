// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IPriceFeedView — minimal read surface of a price source (SimplePriceOracle-compatible).
/// @notice Returns the price of `token` scaled to 1e18 in a stable quote unit. The fee oracle
///         reads PRANA's price through this to make the fee COUNTERCYCLICAL (more fee when PRANA
///         is cheap/abundant, less when scarce/valuable).
interface IPriceFeedView {
    /// @return p Price of `token` scaled to 1e18 (in the quote/reference unit).
    function price(address token) external view returns (uint256 p);
}
