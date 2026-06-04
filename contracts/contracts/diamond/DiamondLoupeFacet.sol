// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LibDiamond} from "./LibDiamond.sol";
import {IDiamondLoupe} from "./interfaces/IDiamondLoupe.sol";
import {IERC165} from "./interfaces/IERC165.sol";

/// @title DiamondLoupeFacet — EIP-2535 introspection over {LibDiamond}'s routing table.
/// @notice Read-only views that let tools reconstruct the diamond's facet/selector map, plus
///         ERC-165 detection. Every getter reads the same shared diamond storage the dispatcher
///         routes through.
contract DiamondLoupeFacet is IDiamondLoupe, IERC165 {
    /// @inheritdoc IDiamondLoupe
    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 numFacets = ds.facetAddresses.length;
        facets_ = new Facet[](numFacets);
        for (uint256 i; i < numFacets; i++) {
            address facetAddr = ds.facetAddresses[i];
            facets_[i].facetAddress = facetAddr;
            facets_[i].functionSelectors = ds.facetFunctionSelectors[facetAddr].functionSelectors;
        }
    }

    /// @inheritdoc IDiamondLoupe
    function facetFunctionSelectors(address _facet)
        external
        view
        override
        returns (bytes4[] memory facetFunctionSelectors_)
    {
        facetFunctionSelectors_ = LibDiamond.diamondStorage()
            .facetFunctionSelectors[_facet]
            .functionSelectors;
    }

    /// @inheritdoc IDiamondLoupe
    function facetAddresses() external view override returns (address[] memory facetAddresses_) {
        facetAddresses_ = LibDiamond.diamondStorage().facetAddresses;
    }

    /// @inheritdoc IDiamondLoupe
    function facetAddress(bytes4 _functionSelector)
        external
        view
        override
        returns (address facetAddress_)
    {
        facetAddress_ = LibDiamond.diamondStorage()
            .selectorToFacetAndPosition[_functionSelector]
            .facetAddress;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 _interfaceId) external view override returns (bool) {
        return LibDiamond.diamondStorage().supportedInterfaces[_interfaceId];
    }
}
