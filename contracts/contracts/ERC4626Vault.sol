// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice Minimal ERC-4626 tokenized vault: deposit an underlying asset, receive
///         share tokens; redeem shares back for the underlying plus any yield the
///         vault has accrued. Standard OpenZeppelin behavior, no fees or hooks.
contract ERC4626Vault is ERC4626 {
    /// @param asset_   The underlying ERC-20 the vault holds and accounts in.
    /// @param name_    Name of the share token (e.g. "PRANA Vault Share").
    /// @param symbol_  Symbol of the share token (e.g. "pvAST").
    constructor(IERC20 asset_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {}
}
