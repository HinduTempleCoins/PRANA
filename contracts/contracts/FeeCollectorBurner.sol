// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title FeeCollectorBurner — route protocol fees here, sweep to burn them
/// @notice The deflationary fee route: any fees sent (in `token`) accumulate here; calling `sweep()`
///         burns the whole balance, permanently reducing supply. Immutable, permissionless sweep.
contract FeeCollectorBurner {
    ERC20Burnable public immutable token;
    uint256 public totalBurned;

    event Swept(uint256 amount);

    constructor(ERC20Burnable token_) {
        require(address(token_) != address(0), "token=0");
        token = token_;
    }

    function pending() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function sweep() external returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        require(amount > 0, "nothing");
        token.burn(amount);
        totalBurned += amount;
        emit Swept(amount);
    }
}
