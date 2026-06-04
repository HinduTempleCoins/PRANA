// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title RebasingToken — adversarial test ERC-20 whose balances scale by a global multiplier
/// @notice Non-standard token (aToken / stETH style): internal "shares" are fixed, but the reported
///         `balanceOf` and `totalSupply` are `shares * multiplier / 1e18`. Calling {rebase} changes
///         the multiplier, so a balance a contract recorded at deposit time silently grows or shrinks
///         while the tokens sit in the contract. Used to probe whether contracts that snapshot a
///         deposited amount mis-account after a rebase. TEST ONLY — never deploy to a real chain.
contract RebasingToken is ERC20Burnable {
    uint256 private constant ONE = 1e18;

    /// @notice Global scaling factor applied to shares -> tokens. Starts at 1e18 (1.0x).
    uint256 public multiplier = ONE;

    mapping(address => uint256) private _shares;
    uint256 private _totalShares;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    // ----- share <-> token conversion -----
    function _toTokens(uint256 shares) internal view returns (uint256) {
        return (shares * multiplier) / ONE;
    }

    function _toShares(uint256 tokens) internal view returns (uint256) {
        return (tokens * ONE) / multiplier;
    }

    // ----- ERC20 surface backed by shares -----
    function totalSupply() public view override returns (uint256) {
        return _toTokens(_totalShares);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _toTokens(_shares[account]);
    }

    /// @notice Mint `amount` tokens (converted to shares at the current multiplier).
    function mint(address to, uint256 amount) external {
        _mint(to, amount); // routes through _update, which converts to shares
    }

    /// @notice Set the global multiplier (1e18 = 1.0x). >1e18 inflates balances, <1e18 deflates them.
    function rebase(uint256 newMultiplier) external {
        require(newMultiplier > 0, "mult=0");
        multiplier = newMultiplier;
    }

    /// @dev Move tokens by converting to shares so rounding mirrors a real rebasing token.
    function _update(address from, address to, uint256 value) internal override {
        uint256 s = _toShares(value);
        if (from == address(0)) {
            _totalShares += s;
        } else {
            uint256 fromShares = _shares[from];
            require(fromShares >= s, "ERC20: balance");
            _shares[from] = fromShares - s;
        }
        if (to == address(0)) {
            _totalShares -= s;
        } else {
            _shares[to] += s;
        }
        emit Transfer(from, to, value);
    }
}
