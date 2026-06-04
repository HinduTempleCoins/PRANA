// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDiamondLoupe — the EIP-2535 introspection surface.
/// @notice Read-only view of a diamond's routing table: which facets exist and which selectors
///         each one serves. Tools (explorers, upgrade scripts) call these to reconstruct the
///         diamond's shape without trusting off-chain bookkeeping.
interface IDiamondLoupe {
    /// @param facetAddress The facet contract address.
    /// @param functionSelectors The selectors that route to that facet.
    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }

    /// @notice All facets and their selectors.
    function facets() external view returns (Facet[] memory facets_);

    /// @notice All selectors routed to `_facet`.
    function facetFunctionSelectors(address _facet)
        external
        view
        returns (bytes4[] memory facetFunctionSelectors_);

    /// @notice All facet addresses currently registered.
    function facetAddresses() external view returns (address[] memory facetAddresses_);

    /// @notice The facet that serves `_functionSelector` (address(0) if none).
    function facetAddress(bytes4 _functionSelector)
        external
        view
        returns (address facetAddress_);
}
