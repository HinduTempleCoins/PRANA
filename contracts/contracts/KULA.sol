// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title KULA — the heart-of-the-farm token for KulaSwap (MELEK / PRANA ecosystem)
///
/// @notice KULA is the reward + governance token that the whole yield farm revolves around. It is
///         the SAME audited OpenZeppelin composition as {ERC20Base} (burnable, hard-capped, pausable,
///         EIP-2612 permit, role-gated mint) — the project-specific ECONOMICS live OUTSIDE the token,
///         in the modules that hold MINTER_ROLE, exactly so the token itself stays minimal and easy to
///         audit and the economics stay reconfigurable. KULA earners (per the design doc):
///           - PRANA GPU / AI-useful-work MINERS  → compute creditors mint KULA (the SBD-floored pay)
///           - KulaSwap LPs / stakers             → LiquidityGauge / EmissionScheduler mint KULA
///           - PoL burners                        → a BurnMine(PoL→KULA) holds MINTER_ROLE
///         Supply starts at zero (no premine). `cap` bounds total emission; pass type(uint256).max for
///         uncapped. The SBD-style value floor, the lottery, ve-locking and gauge direction are all
///         SEPARATE contracts that consume/mint KULA — none of that logic is baked into the token.
///
/// @dev Grant MINTER_ROLE to each emission source (EmissionScheduler, the gauges, the compute
///      creditors, the PoL→KULA BurnMine). Grant PAUSER_ROLE to a guardian/timelock. Burning is open
///      to holders (ERC20Burnable) so sinks (burn-mine, lottery entry) can consume supply.
contract KULA is ERC20, ERC20Burnable, ERC20Capped, ERC20Pausable, ERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @param cap_   hard supply cap (total KULA that can ever be minted); type(uint256).max = uncapped.
    /// @param admin  receives DEFAULT_ADMIN_ROLE (manages roles) + MINTER_ROLE + PAUSER_ROLE initially.
    constructor(uint256 cap_, uint256 creationMint_, address treasury_, address admin)
        ERC20("KulaSwap", "KULA")
        ERC20Capped(cap_)
        ERC20Permit("KulaSwap")
    {
        require(admin != address(0) && treasury_ != address(0), "zero addr");
        require(cap_ > 0, "cap=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        // Deployer/admin is deliberately NOT granted MINTER_ROLE. KULA is emission-only: MINTER_ROLE is
        // granted (by admin) solely to the EmissionScheduler + Burn-Mine after deploy, and admin then
        // moves to a timelock. The creation mint below is the ONLY founding supply, minted at creation.
        if (creationMint_ > 0) _mint(treasury_, creationMint_);
    }

    /// @notice Mint KULA. Restricted to MINTER_ROLE (the emission/creditor/gauge/burn-mine modules).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // Single _update override resolving ERC20 + Capped + Pausable (OZ v5 hook).
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Capped, ERC20Pausable)
    {
        super._update(from, to, value);
    }
}
