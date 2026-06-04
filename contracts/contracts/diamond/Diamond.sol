// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LibDiamond} from "./LibDiamond.sol";
import {IDiamondCut} from "./interfaces/IDiamondCut.sol";

/// @title Diamond — the ERC-2535 proxy core.
/// @notice A single deployed address whose code is just a dispatcher: every external call falls
///         through to {fallback}, which looks up the selector in {LibDiamond}'s routing table and
///         delegatecalls the owning facet. All facets execute in THIS contract's storage context,
///         so they share one state (see {LibDiamond.DiamondStorage} and the demo mesh facet).
/// @dev Bootstrap: the constructor installs ownership and a single `diamondCut` selector pointing at
///      a pre-deployed {DiamondCutFacet}. From there the owner adds loupe/demo facets via cuts.
contract Diamond {
    error FunctionNotFound(bytes4 selector);

    /// @param _contractOwner The initial diamond owner (gates all future cuts).
    /// @param _diamondCutFacet A deployed DiamondCutFacet supplying the `diamondCut` selector.
    constructor(address _contractOwner, address _diamondCutFacet) payable {
        LibDiamond.setContractOwner(_contractOwner);

        // Seed the routing table with just diamondCut(...) so the owner can grow the diamond.
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = IDiamondCut.diamondCut.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: _diamondCutFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        LibDiamond.diamondCut(cut, address(0), "");
    }

    /// @notice Route every call to its facet via delegatecall, preserving calldata and return data.
    /// @dev Reverts with {FunctionNotFound} if the selector is unrouted.
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds;
        bytes32 position = LibDiamond.DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        if (facet == address(0)) revert FunctionNotFound(msg.sig);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    /// @notice Accept bare value transfers.
    receive() external payable {}
}
