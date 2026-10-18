// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MWALI — the KulaSwap liquidity token (the Kula-ring armshell that circulates).
/// @notice Generic mintable + burnable ERC-20. Minting is gated by MINTER_ROLE (the liquidity
///         distributor mints it per block to LPs); burning is open to holders so the sink
///         (burn -> KULA, burn -> lotto tickets) can consume supply. No premine: supply starts at zero.
contract Mwali is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @param admin receives DEFAULT_ADMIN_ROLE (can manage roles). Emission-only: NOT a minter.
    constructor(address admin) ERC20("Mwali", "MWALI") {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Emission-only: deployer/admin is NOT granted MINTER_ROLE. MINTER_ROLE is granted (by admin)
        // solely to the liquidity gauge / emission module after deploy, then admin moves to a timelock.
    }

    /// @notice Mint new MWALI. Restricted to MINTER_ROLE holders.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
