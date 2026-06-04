// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title InterestRateModel — jump-rate model (Compound/Aave style)
/// @notice Pure function from pool utilization to a borrow rate: linear (slope1) up to a `kink`
///         utilization, then steeper (slope2) beyond it to penalize over-borrowing. Rates are
///         per-second, scaled by 1e18. Pluggable into the lending vault.
contract InterestRateModel {
    uint256 private constant WAD = 1e18;

    uint256 public immutable baseRate;  // rate at 0% utilization
    uint256 public immutable slope1;    // slope below the kink
    uint256 public immutable slope2;    // slope above the kink
    uint256 public immutable kink;      // utilization breakpoint (<= 1e18)

    constructor(uint256 baseRate_, uint256 slope1_, uint256 slope2_, uint256 kink_) {
        require(kink_ <= WAD, "kink>1");
        baseRate = baseRate_;
        slope1 = slope1_;
        slope2 = slope2_;
        kink = kink_;
    }

    /// @notice Utilization = borrows / (cash + borrows), scaled by 1e18.
    function utilization(uint256 cash, uint256 borrows) public pure returns (uint256) {
        if (borrows == 0) return 0;
        return (borrows * WAD) / (cash + borrows);
    }

    /// @notice Per-second borrow rate (scaled 1e18) for the given liquidity state.
    function borrowRate(uint256 cash, uint256 borrows) public view returns (uint256) {
        uint256 u = utilization(cash, borrows);
        if (u <= kink) {
            return baseRate + (u * slope1) / WAD;
        }
        uint256 atKink = baseRate + (kink * slope1) / WAD;
        return atKink + ((u - kink) * slope2) / WAD;
    }
}
