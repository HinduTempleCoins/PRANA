// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYieldStrategy} from "../interfaces/IYieldStrategy.sol";

/// @notice Test-only {IYieldStrategy}: holds the deposited asset and lets a test simulate yield by
///         minting extra asset straight into the strategy (via {accrueYield}). totalAssets() is just
///         the strategy's balance, so principal stays recoverable and surplus = yield. TEST ONLY.
contract MockYieldStrategy is IYieldStrategy {
    using SafeERC20 for IERC20;

    address public immutable assetToken;

    constructor(address asset_) {
        assetToken = asset_;
    }

    function asset() external view returns (address) {
        return assetToken;
    }

    function deposit(uint256 amount) external returns (uint256) {
        IERC20(assetToken).safeTransferFrom(msg.sender, address(this), amount);
        return amount;
    }

    function withdraw(uint256 amount, address to) external returns (uint256) {
        IERC20(assetToken).safeTransfer(to, amount);
        return amount;
    }

    function totalAssets() external view returns (uint256) {
        return IERC20(assetToken).balanceOf(address(this));
    }
}
