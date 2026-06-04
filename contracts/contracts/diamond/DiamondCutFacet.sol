// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LibDiamond} from "./LibDiamond.sol";
import {IDiamondCut} from "./interfaces/IDiamondCut.sol";

/// @title DiamondCutFacet — the upgrade entrypoint of an ERC-2535 diamond.
/// @notice Owner-gated add/replace/remove of facet selectors, plus an optional initializer
///         delegatecall. All bookkeeping lives in {LibDiamond}; this facet is a thin owner gate.
contract DiamondCutFacet is IDiamondCut {
    /// @inheritdoc IDiamondCut
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }
}
