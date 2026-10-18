// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MelekBorrowNote — the KULA-CDP synthetic MELEK borrow token (emission-only).
/// @notice Minted ONLY by the CDPVault when a user locks KULA and borrows against it; burned on
///         repay/liquidate (ERC20Burnable). This is the CDP debt unit, deliberately SEPARATE from
///         the bridge wMELEK (whose supply must equal MELEK locked in the bridge) so CDP issuance
///         can never violate the bridge 1:1 lock invariant. Emission-only: the deployer is NOT
///         granted MINTER_ROLE — only the CDPVault holds it.
contract MelekBorrowNote is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(address admin) ERC20("MELEK Borrow Note (KULA CDP)", "mMELEK") {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Deployer deliberately NOT granted MINTER_ROLE; granted only to the CDPVault post-deploy.
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
