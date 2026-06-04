// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title BondingCurveToken
/// @notice An ERC-20 minted and burned against a reserve token along a LINEAR bonding curve.
///         The marginal price of the k-th token (0-indexed) is:
///
///             price(k) = basePrice + slope * k        [reserve units]
///
///         The curve is discretized over whole tokens (integer `totalSupply`), so every
///         cost/refund is an exact integer sum of marginal prices — no floating point,
///         no per-trade rounding drift. The reserve held by the contract therefore always
///         equals the integral of the curve from 0 to the current supply, which guarantees
///         a buy-then-sell round trip leaves no free (extractable) reserve behind.
///
/// @dev `basePrice` and `slope` are expressed in the reserve token's smallest unit per
///      whole curve-token. With an 18-decimal reserve, e.g. basePrice = 1e18 means the first
///      token costs 1 whole reserve token. Curve tokens are tracked as whole integer units
///      here (the ERC-20 `decimals()` is the default 18 for wallet display, but the curve
///      math operates on the raw integer supply returned by `totalSupply()`).
contract BondingCurveToken is ERC20 {
    using SafeERC20 for IERC20;

    /// @notice The reserve currency pulled in on buys and paid out on sells.
    IERC20 public immutable reserve;

    /// @notice Price of the very first token (supply 0 -> 1), in reserve units.
    uint256 public immutable basePrice;

    /// @notice Per-token linear price increment, in reserve units.
    uint256 public immutable slope;

    error ZeroAmount();
    error InsufficientBalance();
    error ReserveCapExceeded(uint256 cost, uint256 cap);
    error MinReserveNotMet(uint256 refund, uint256 minOut);

    /// @param name_      ERC-20 name of the curve token.
    /// @param symbol_    ERC-20 symbol of the curve token.
    /// @param reserve_   Reserve token address (must be a standard ERC-20).
    /// @param basePrice_ Price of the first token, in reserve units (> 0 recommended).
    /// @param slope_     Linear per-token price increment, in reserve units.
    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 reserve_,
        uint256 basePrice_,
        uint256 slope_
    ) ERC20(name_, symbol_) {
        require(address(reserve_) != address(0), "reserve=0");
        reserve = reserve_;
        basePrice = basePrice_;
        slope = slope_;
    }

    // ----------------------------------------------------------------------------------
    // Curve math (views)
    // ----------------------------------------------------------------------------------

    /// @notice Cost in reserve units to mint `n` tokens starting from the current supply.
    /// @dev Cost = sum over k in [s, s+n) of (basePrice + slope*k)
    ///           = n*basePrice + slope*(s*n + n*(n-1)/2)
    ///      where s = current totalSupply. `n*(n-1)` is always even, so the /2 is exact.
    function costToMint(uint256 n) public view returns (uint256) {
        return _segmentCost(totalSupply(), n);
    }

    /// @notice Reserve units returned for burning `n` tokens from the current supply.
    /// @dev By symmetry this equals the cost of the segment [s-n, s): the exact same
    ///      marginal prices that were paid to mint those tokens, so the round trip is
    ///      conservative (a buy of n then a sell of n returns exactly the reserve paid).
    function refundOnBurn(uint256 n) public view returns (uint256) {
        uint256 s = totalSupply();
        if (n > s) revert InsufficientBalance();
        return _segmentCost(s - n, n);
    }

    /// @dev Cost of minting `n` tokens that occupy supply positions [start, start+n).
    ///      Sum of (basePrice + slope*k) for k in [start, start+n).
    function _segmentCost(uint256 start, uint256 n) internal view returns (uint256) {
        if (n == 0) return 0;
        // sum of k over [start, start+n) = start*n + n*(n-1)/2
        uint256 indexSum = start * n + (n * (n - 1)) / 2;
        return n * basePrice + slope * indexSum;
    }

    /// @notice Marginal price of the next token to be minted, in reserve units.
    function spotPrice() external view returns (uint256) {
        return basePrice + slope * totalSupply();
    }

    // ----------------------------------------------------------------------------------
    // Buy / Sell
    // ----------------------------------------------------------------------------------

    /// @notice Mint exactly `tokens` curve-tokens to the caller, pulling the exact curve
    ///         cost in reserve. Reverts if that cost exceeds `maxReserveIn` (slippage cap).
    /// @param tokens       Number of whole curve-tokens to mint.
    /// @param maxReserveIn Maximum reserve the caller is willing to pay.
    /// @return cost        Reserve actually pulled from the caller.
    function buy(uint256 tokens, uint256 maxReserveIn) external returns (uint256 cost) {
        if (tokens == 0) revert ZeroAmount();
        cost = costToMint(tokens);
        if (cost > maxReserveIn) revert ReserveCapExceeded(cost, maxReserveIn);

        // Effects + interaction: pull reserve first, then mint.
        reserve.safeTransferFrom(msg.sender, address(this), cost);
        _mint(msg.sender, tokens);
    }

    /// @notice Burn exactly `tokens` curve-tokens from the caller and return reserve along
    ///         the curve. Reverts if `minReserveOut` is not met (slippage floor).
    /// @param tokens        Number of whole curve-tokens to burn.
    /// @param minReserveOut Minimum reserve the caller will accept.
    /// @return refund       Reserve paid out to the caller.
    function sell(uint256 tokens, uint256 minReserveOut) external returns (uint256 refund) {
        if (tokens == 0) revert ZeroAmount();
        if (tokens > balanceOf(msg.sender)) revert InsufficientBalance();

        refund = refundOnBurn(tokens);
        if (refund < minReserveOut) revert MinReserveNotMet(refund, minReserveOut);

        // Burn first (reduces supply, moves the curve down), then pay out.
        _burn(msg.sender, tokens);
        reserve.safeTransfer(msg.sender, refund);
    }
}
