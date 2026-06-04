// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeRouter
/// @notice Routes a fee token to a fixed set of destinations by basis points.
///         Configuration is immutable: destinations and their shares are set
///         once at construction and the shares must sum to exactly 10000 bps.
/// @dev On each `distribute` call the router reads its own current balance of
///      the given token and forwards each destination its bps share. The last
///      destination receives the remainder so no dust is left behind.
contract FeeRouter {
    using SafeERC20 for IERC20;

    uint16 public constant TOTAL_BPS = 10000;

    /// @notice Ordered list of payout destinations.
    address[] private _destinations;
    /// @notice Basis-point share for each destination, index-aligned with `_destinations`.
    uint16[] private _bps;

    error LengthMismatch();
    error NoDestinations();
    error ZeroDestination();
    error ZeroBps();
    error BpsSumNot10000(uint256 got);

    event Distributed(address indexed token, uint256 total);

    constructor(address[] memory destinations, uint16[] memory bps) {
        if (destinations.length != bps.length) revert LengthMismatch();
        if (destinations.length == 0) revert NoDestinations();

        uint256 sum;
        for (uint256 i = 0; i < destinations.length; i++) {
            if (destinations[i] == address(0)) revert ZeroDestination();
            if (bps[i] == 0) revert ZeroBps();
            sum += bps[i];
            _destinations.push(destinations[i]);
            _bps.push(bps[i]);
        }
        if (sum != TOTAL_BPS) revert BpsSumNot10000(sum);
    }

    /// @notice Reads this contract's current `token` balance and splits it across
    ///         the configured destinations by basis points. The last destination
    ///         gets the remainder to avoid dust. No-ops when the balance is zero.
    function distribute(IERC20 token) external {
        uint256 total = token.balanceOf(address(this));
        if (total == 0) return;

        uint256 len = _destinations.length;
        uint256 distributed;
        // All but the last destination get floor(total * bps / 10000).
        for (uint256 i = 0; i < len - 1; i++) {
            uint256 share = (total * _bps[i]) / TOTAL_BPS;
            distributed += share;
            token.safeTransfer(_destinations[i], share);
        }
        // Last destination sweeps the remainder (handles rounding dust).
        token.safeTransfer(_destinations[len - 1], total - distributed);

        emit Distributed(address(token), total);
    }

    function destinationsCount() external view returns (uint256) {
        return _destinations.length;
    }

    function destinationAt(uint256 i) external view returns (address) {
        return _destinations[i];
    }

    function bpsAt(uint256 i) external view returns (uint16) {
        return _bps[i];
    }
}
