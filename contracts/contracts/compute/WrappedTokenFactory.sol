// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WrappedEcosystemToken} from "./WrappedEcosystemToken.sol";

/// @title WrappedTokenFactory — deploys one {WrappedEcosystemToken} per origin token + registry
///
/// @notice Mirrors {ERC20CloneFactory}'s factory+registry pattern: each call deploys a canonical
///         lock-mint wrapper for a given origin token, registers it in `allWrapped[]` and the
///         `wrappedOf` lookup, and emits {WrappedCreated}. The set of wrappers it has created is
///         the canonical list of ecosystem tokens admissible to the PRANA burn economy.
///
/// @dev    Full-deploy (not EIP-1167 clones): {WrappedEcosystemToken} has immutables (decimals,
///         originRef) and a constructor, so it is deployed directly. A `DEPLOYER_ROLE`-style gate
///         is intentionally omitted at this layer — gating *which* wrappers are admitted to mining
///         is the {MultiCurrencyBurnRouter}'s allowlist concern; this factory is a deployment +
///         registry utility. Restrict who can call it via the deploying account if needed.
///
///         ⚠️ Each wrapper carries the STAGE-2 single-custodian trust posture — see
///         {WrappedEcosystemToken} and {PeggedBridgeVault}. The audited 2-way bridge is stage 3.
contract WrappedTokenFactory {
    /// @notice Every wrapper this factory has deployed, in creation order.
    address[] public allWrapped;

    /// @notice originRef => the wrapper deployed for it (address(0) if none). One canonical wrapper
    ///         per origin token; re-deploying the same originRef is rejected to keep the mapping 1:1.
    mapping(bytes32 => address) public wrappedOf;

    event WrappedCreated(
        address indexed token,
        bytes32 indexed originRef,
        string name,
        string symbol,
        uint8 decimals,
        address admin,
        address custodian
    );

    error OriginAlreadyWrapped(bytes32 originRef, address existing);

    /// @notice Deploy + register a {WrappedEcosystemToken} for `originRef`.
    /// @param name_      e.g. "Wrapped MELEK".
    /// @param symbol_    e.g. "wMELEK".
    /// @param decimals_  SHOULD match the origin token's decimals.
    /// @param originRef_ Opaque reference pairing the wrapper to its origin token (unique per call).
    /// @param admin_     DEFAULT_ADMIN_ROLE on the new wrapper.
    /// @param custodian_ CUSTODIAN_ROLE (the trusted stage-2 bridge operator) on the new wrapper.
    /// @return token     The deployed wrapper address.
    function createWrapped(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        bytes32 originRef_,
        address admin_,
        address custodian_
    ) external returns (address token) {
        address existing = wrappedOf[originRef_];
        if (existing != address(0)) revert OriginAlreadyWrapped(originRef_, existing);

        WrappedEcosystemToken w = new WrappedEcosystemToken(
            name_,
            symbol_,
            decimals_,
            originRef_,
            admin_,
            custodian_
        );
        token = address(w);

        wrappedOf[originRef_] = token;
        allWrapped.push(token);
        emit WrappedCreated(token, originRef_, name_, symbol_, decimals_, admin_, custodian_);
    }

    /// @notice Number of wrappers deployed by this factory.
    function wrappedCount() external view returns (uint256) {
        return allWrapped.length;
    }
}
