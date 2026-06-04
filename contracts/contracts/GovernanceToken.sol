// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title GovernanceToken — an ERC-20 with on-chain voting power for a Governor.
/// @notice Composes OpenZeppelin ERC20 + ERC20Permit (EIP-2612) + ERC20Votes (ERC-5805/6372
///         checkpointed voting power). Supply starts at zero (no premine); a role-gated `mint`
///         issues new tokens. Holders must `delegate` (e.g. to themselves) to activate voting
///         power. Generic and reusable — no project-specific economics baked in.
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @param name_   token name (also used as the EIP-712 / permit domain name)
    /// @param symbol_ token symbol
    /// @param admin   receives DEFAULT_ADMIN_ROLE + MINTER_ROLE
    constructor(string memory name_, string memory symbol_, address admin)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint new tokens. Restricted to MINTER_ROLE.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    // ---- required overrides for OZ 5.x multiple inheritance ----

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
