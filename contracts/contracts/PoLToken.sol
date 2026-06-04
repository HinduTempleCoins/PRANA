// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Proof-of-Liquidity reward token (POL)
/// @notice Generic mintable + burnable ERC-20. Minting is gated by MINTER_ROLE so an emission
///         module (a liquidity-reward distributor) can mint rewards, while burning is open to
///         holders (so a sink contract can consume supply). No premine: supply starts at zero.
contract PoLToken is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @param admin receives DEFAULT_ADMIN_ROLE (can manage roles) and MINTER_ROLE initially.
    constructor(address admin) ERC20("Proof of Liquidity", "POL") {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint new tokens. Restricted to MINTER_ROLE holders.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
