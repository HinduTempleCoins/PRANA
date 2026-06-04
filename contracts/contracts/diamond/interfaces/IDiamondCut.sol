// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDiamondCut — the EIP-2535 upgrade surface.
/// @notice Add, replace, or remove facet functions on a diamond, with an optional initializer
///         delegatecall. This is the canonical reference shape from the standard.
interface IDiamondCut {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }

    /// @param facetAddress The facet to route the selectors to (must be address(0) for Remove).
    /// @param action Add / Replace / Remove.
    /// @param functionSelectors The selectors affected by this cut.
    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    /// @notice Emitted for every applied cut (mirrors the struct so indexers can replay routing).
    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);

    /// @notice Add/replace/remove functions and optionally execute `_calldata` on `_init` via
    ///         delegatecall.
    /// @param _diamondCut The set of facet cuts to apply.
    /// @param _init Initializer contract delegatecalled after the cut (address(0) to skip).
    /// @param _calldata Calldata passed to the initializer.
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external;
}
