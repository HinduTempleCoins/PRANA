// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title WrappedEcosystemToken — canonical lock-mint wrapper for an ecosystem native token
///
/// @notice ⚠️⚠️ TRUSTED, NON-FINAL (STAGE-2) WRAPPER. READ BEFORE USING. ⚠️⚠️
///         This is the PRANA-side ERC-20 representation of a token whose canonical home is ANOTHER
///         chain (e.g. wMELEK ← MELEK, wVKBT ← VKBT, CURE ← its origin). The trust model is the
///         SAME single-custodian posture as {PeggedBridgeVault}:
///
///           - A holder of {CUSTODIAN_ROLE} (typically the PeggedBridgeVault, or a trusted off-chain
///             bridge operator) `mint`s wrapped supply HERE only after it has observed the native
///             token being LOCKED/escrowed on the origin chain.
///           - On `unwrap`, the user's wrapped supply is BURNED here; the custodian observes that
///             burn off-chain and RELEASES the locked native on the origin chain.
///           - THERE IS NO ON-CHAIN PROOF of the remote lock/release. A compromised or dishonest
///             custodian could mint wrapped supply with no matching origin lock. The trust
///             assumption is identical to a centralized exchange's deposit/withdraw — NOT a
///             trustless bridge.
///
///         STAGE 3 (the audited, two-way, light-client / multi-attester bridge) WILL REPLACE this
///         minting authority. Do not build large TVL on top of the stage-2 custodian.
///
/// @dev Why this token exists for PRANA: wrapped ecosystem tokens are the on-ramp into PRANA's
///      burn-to-mine economy. The {MultiCurrencyBurnRouter} accepts these wrapped tokens, BURNS
///      them (via {ERC20Burnable}), and credits normalized BurnStakeRegistry weight — making every
///      ecosystem token a deflationary SINK that flows value into PRANA mining.
///
///      `unwrap` and the router's burn both use the standard {ERC20Burnable} machinery, so the
///      custodian's release accounting (origin-chain) keys off the on-chain `Transfer(.., 0x0, ..)`
///      burn events emitted here.
contract WrappedEcosystemToken is ERC20, ERC20Burnable, ERC20Permit, AccessControl {
    /// @notice Role permitted to {mint} wrapped supply in response to an observed origin-chain lock.
    bytes32 public constant CUSTODIAN_ROLE = keccak256("CUSTODIAN_ROLE");

    uint8 private immutable _decimals;

    /// @notice Opaque reference to the origin token (e.g. its origin-chain address / symbol hash).
    ///         Informational only — used by off-chain tooling and explorers to pair this wrapper
    ///         with its canonical native token.
    bytes32 public immutable originRef;

    event WrappedMinted(address indexed to, uint256 amount, bytes32 indexed originLockRef);
    event Unwrapped(address indexed from, uint256 amount, bytes32 indexed originRecipientRef);

    error ZeroAddress();
    error ZeroAmount();

    /// @param name_      ERC-20 name (e.g. "Wrapped MELEK").
    /// @param symbol_    ERC-20 symbol (e.g. "wMELEK").
    /// @param decimals_  Decimals — SHOULD match the origin token's decimals for 1:1 wrapping.
    /// @param originRef_ Opaque reference pairing this wrapper to its origin token.
    /// @param admin_     Receives DEFAULT_ADMIN_ROLE (manages the custodian set).
    /// @param custodian_ The single trusted bridge operator granted CUSTODIAN_ROLE.
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        bytes32 originRef_,
        address admin_,
        address custodian_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (admin_ == address(0) || custodian_ == address(0)) revert ZeroAddress();
        _decimals = decimals_;
        originRef = originRef_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(CUSTODIAN_ROLE, custodian_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice STAGE-2 mint: the custodian credits `to` after observing the native token locked on
    ///         the origin chain. `originLockRef` is the opaque ref of that remote lock (for audit).
    /// @dev    See the contract-level trust warning. No on-chain proof of the remote lock exists.
    function mint(address to, uint256 amount, bytes32 originLockRef)
        external
        onlyRole(CUSTODIAN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit WrappedMinted(to, amount, originLockRef);
    }

    /// @notice User-initiated unwrap: burns the caller's wrapped supply and emits {Unwrapped}. The
    ///         custodian observes this burn off-chain and releases the locked native on the origin
    ///         chain to `originRecipientRef` (an opaque encoding of the destination address).
    /// @dev    This is sugar over {ERC20Burnable-burn} that additionally records the destination ref.
    function unwrap(uint256 amount, bytes32 originRecipientRef) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount); // reverts on insufficient balance
        emit Unwrapped(msg.sender, amount, originRecipientRef);
    }
}
