// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title FeeOnTransferToken — adversarial test ERC-20 that skims a fee on every transfer
/// @notice Non-standard ("deflationary") token: each `transfer`/`transferFrom` burns a fixed
///         basis-point fee out of the moved amount, so the recipient receives LESS than was sent.
///         Used to probe whether contracts that pull tokens in credit the *requested* amount versus
///         the *actually-received* amount. A correct contract must measure the balance delta.
///         Burnable so it can stand in as a burn-mine input. TEST ONLY — never deploy to a real chain.
contract FeeOnTransferToken is ERC20, ERC20Burnable {
    /// @notice Fee charged per transfer, in basis points (e.g. 100 = 1%).
    uint256 public immutable feeBps;
    uint256 public constant BPS = 10_000;

    /// @notice Total fee burned over the token's lifetime (for test assertions).
    uint256 public totalFeeBurned;

    constructor(string memory name_, string memory symbol_, uint256 feeBps_)
        ERC20(name_, symbol_)
    {
        require(feeBps_ < BPS, "fee>=100%");
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Intercept all balance-moving transfers (mint/burn skip the fee because one side is zero).
    ///      The fee is burned out of the transferred value so the receiver is short-changed.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / BPS;
            if (fee > 0) {
                // Burn the fee from the sender's moving amount: receiver gets value - fee.
                super._update(from, address(0), fee);
                totalFeeBurned += fee;
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
