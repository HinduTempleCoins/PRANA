// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ERC20Base — the configurable token template used by the deploy-wizard factory
/// @notice Mintable (role-gated), burnable, hard-capped, pausable, and EIP-2612 permit-enabled.
///         Supply starts at zero (no premine); a `cap` of 0 means uncapped. This is the audited
///         OpenZeppelin composition — generic, reusable, no project-specific economics baked in.
contract ERC20Base is ERC20, ERC20Burnable, ERC20Capped, ERC20Pausable, ERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @param cap_ hard supply cap; pass type(uint256).max for effectively uncapped.
    constructor(string memory name_, string memory symbol_, uint256 cap_, address admin)
        ERC20(name_, symbol_)
        ERC20Capped(cap_)
        ERC20Permit(name_)
    {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ---- single _update override resolving ERC20 + Capped + Pausable ----
    function _update(address from, address to, uint256 value)
        internal override(ERC20, ERC20Capped, ERC20Pausable)
    {
        super._update(from, to, value);
    }
}
