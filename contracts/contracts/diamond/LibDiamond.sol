// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IDiamondCut} from "./interfaces/IDiamondCut.sol";

/// @title LibDiamond — namespaced storage + cut/ownership internals for an ERC-2535 diamond.
/// @notice This library holds the diamond's mutable routing table (selector => facet) and the
///         data the loupe reports, all in a single deterministic storage slot so that every facet
///         (which runs in the diamond's storage context via delegatecall) sees the SAME state
///         without clashing with any facet's own variables. This is the "Diamond Storage" pattern
///         from EIP-2535.
/// @dev Storage layout is FROZEN: never reorder or remove members of {DiamondStorage}; only append.
///      Reordering would corrupt a live diamond because facets read this struct by slot offset.
library LibDiamond {
    /// @dev keccak256("diamond.standard.diamond.storage") — the canonical EIP-2535 slot.
    bytes32 internal constant DIAMOND_STORAGE_POSITION =
        keccak256("diamond.standard.diamond.storage");

    /// @notice Routing record for one selector.
    /// @param facetAddress       The facet implementing the selector (delegatecall target).
    /// @param functionSelectorPosition Index of the selector within its facet's selector array
    ///        (used for O(1) swap-and-pop removal).
    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition;
    }

    /// @notice Per-facet record used by the loupe to enumerate a facet's selectors.
    /// @param functionSelectors All selectors currently routed to this facet.
    /// @param facetAddressPosition Index of this facet within {facetAddresses}.
    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition;
    }

    /// @notice The diamond's entire mutable routing + ownership state.
    /// @dev Appended-to only. `meshSlot` is a small shared scratch area the demo mesh facets use to
    ///      prove that facets read/write ONE shared state through the diamond (see BurnMineFacet).
    struct DiamondStorage {
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacetAndPosition;
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
        address[] facetAddresses;
        mapping(bytes4 => bool) supportedInterfaces;
        address contractOwner;
    }

    /// @notice Emitted when ownership of the diamond changes.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Mirrors {IDiamondCut.DiamondCut} so emits from this library are ABI-compatible.
    event DiamondCut(IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata);

    error NotContractOwner(address caller, address owner);
    error NoSelectorsInFacet();
    error CutToZeroAddress();
    error FunctionAlreadyExists(bytes4 selector);
    error AddFacetWithZeroAddress();
    error ReplaceFacetWithZeroAddress();
    error CannotReplaceSameFunction(bytes4 selector);
    error RemoveFacetAddressMustBeZero(address facetAddress);
    error CannotRemoveFunctionThatDoesNotExist(bytes4 selector);
    error CannotRemoveImmutableFunction(bytes4 selector);
    error IncorrectFacetCutAction(uint8 action);
    error InitFunctionReverted();
    error InitAddressZeroButCalldataNotEmpty();
    error NoBytecodeAtAddress(address target);

    /// @notice Return the diamond's storage struct, anchored at {DIAMOND_STORAGE_POSITION}.
    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    // --------------------------------------------------------------------- //
    //  Ownership                                                            //
    // --------------------------------------------------------------------- //

    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        address previousOwner = ds.contractOwner;
        ds.contractOwner = _newOwner;
        emit OwnershipTransferred(previousOwner, _newOwner);
    }

    function contractOwner() internal view returns (address) {
        return diamondStorage().contractOwner;
    }

    /// @notice Revert unless the caller is the diamond owner. Cut and other privileged facet
    ///         functions gate on this.
    function enforceIsContractOwner() internal view {
        address owner = diamondStorage().contractOwner;
        if (msg.sender != owner) revert NotContractOwner(msg.sender, owner);
    }

    // --------------------------------------------------------------------- //
    //  Diamond cut (add / replace / remove)                                 //
    // --------------------------------------------------------------------- //

    /// @notice Apply a set of facet cuts, then optionally delegatecall an initializer.
    /// @param _diamondCut Each entry adds/replaces/removes a facet's selectors.
    /// @param _init Optional initializer contract delegatecalled after the cut (address(0) to skip).
    /// @param _calldata Calldata for the initializer.
    function diamondCut(
        IDiamondCut.FacetCut[] memory _diamondCut,
        address _init,
        bytes memory _calldata
    ) internal {
        for (uint256 i; i < _diamondCut.length; i++) {
            IDiamondCut.FacetCutAction action = _diamondCut[i].action;
            bytes4[] memory selectors = _diamondCut[i].functionSelectors;
            address facet = _diamondCut[i].facetAddress;
            if (selectors.length == 0) revert NoSelectorsInFacet();

            if (action == IDiamondCut.FacetCutAction.Add) {
                _addFunctions(facet, selectors);
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                _replaceFunctions(facet, selectors);
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                _removeFunctions(facet, selectors);
            } else {
                revert IncorrectFacetCutAction(uint8(action));
            }
        }
        emit DiamondCut(_diamondCut, _init, _calldata);
        _initializeDiamondCut(_init, _calldata);
    }

    function _addFunctions(address _facet, bytes4[] memory _selectors) internal {
        if (_facet == address(0)) revert AddFacetWithZeroAddress();
        DiamondStorage storage ds = diamondStorage();
        uint96 pos = uint96(ds.facetFunctionSelectors[_facet].functionSelectors.length);
        if (pos == 0) _addFacet(ds, _facet);
        for (uint256 i; i < _selectors.length; i++) {
            bytes4 selector = _selectors[i];
            if (ds.selectorToFacetAndPosition[selector].facetAddress != address(0)) {
                revert FunctionAlreadyExists(selector);
            }
            _addFunction(ds, selector, pos, _facet);
            pos++;
        }
    }

    function _replaceFunctions(address _facet, bytes4[] memory _selectors) internal {
        if (_facet == address(0)) revert ReplaceFacetWithZeroAddress();
        DiamondStorage storage ds = diamondStorage();
        uint96 pos = uint96(ds.facetFunctionSelectors[_facet].functionSelectors.length);
        if (pos == 0) _addFacet(ds, _facet);
        for (uint256 i; i < _selectors.length; i++) {
            bytes4 selector = _selectors[i];
            address old = ds.selectorToFacetAndPosition[selector].facetAddress;
            if (old == _facet) revert CannotReplaceSameFunction(selector);
            if (old == address(0)) revert CannotRemoveFunctionThatDoesNotExist(selector);
            _removeFunction(ds, old, selector);
            _addFunction(ds, selector, pos, _facet);
            pos++;
        }
    }

    function _removeFunctions(address _facet, bytes4[] memory _selectors) internal {
        if (_facet != address(0)) revert RemoveFacetAddressMustBeZero(_facet);
        DiamondStorage storage ds = diamondStorage();
        for (uint256 i; i < _selectors.length; i++) {
            bytes4 selector = _selectors[i];
            address old = ds.selectorToFacetAndPosition[selector].facetAddress;
            if (old == address(0)) revert CannotRemoveFunctionThatDoesNotExist(selector);
            _removeFunction(ds, old, selector);
        }
    }

    function _addFacet(DiamondStorage storage ds, address _facet) internal {
        _enforceHasContractCode(_facet);
        ds.facetFunctionSelectors[_facet].facetAddressPosition = ds.facetAddresses.length;
        ds.facetAddresses.push(_facet);
    }

    function _addFunction(
        DiamondStorage storage ds,
        bytes4 _selector,
        uint96 _position,
        address _facet
    ) internal {
        ds.selectorToFacetAndPosition[_selector].functionSelectorPosition = _position;
        ds.facetFunctionSelectors[_facet].functionSelectors.push(_selector);
        ds.selectorToFacetAndPosition[_selector].facetAddress = _facet;
    }

    function _removeFunction(DiamondStorage storage ds, address _facet, bytes4 _selector) internal {
        // The diamond itself owns the immutable cut/loupe/ownership selectors; never remove those.
        if (_facet == address(this)) revert CannotRemoveImmutableFunction(_selector);

        uint256 selectorPosition = ds.selectorToFacetAndPosition[_selector].functionSelectorPosition;
        uint256 lastSelectorPosition = ds.facetFunctionSelectors[_facet].functionSelectors.length - 1;
        // Swap-and-pop the selector out of the facet's selector array.
        if (selectorPosition != lastSelectorPosition) {
            bytes4 lastSelector = ds.facetFunctionSelectors[_facet].functionSelectors[lastSelectorPosition];
            ds.facetFunctionSelectors[_facet].functionSelectors[selectorPosition] = lastSelector;
            ds.selectorToFacetAndPosition[lastSelector].functionSelectorPosition = uint96(selectorPosition);
        }
        ds.facetFunctionSelectors[_facet].functionSelectors.pop();
        delete ds.selectorToFacetAndPosition[_selector];

        // If the facet now has no selectors, swap-and-pop it out of facetAddresses too.
        if (lastSelectorPosition == 0) {
            uint256 lastFacetPosition = ds.facetAddresses.length - 1;
            uint256 facetAddressPosition = ds.facetFunctionSelectors[_facet].facetAddressPosition;
            if (facetAddressPosition != lastFacetPosition) {
                address lastFacet = ds.facetAddresses[lastFacetPosition];
                ds.facetAddresses[facetAddressPosition] = lastFacet;
                ds.facetFunctionSelectors[lastFacet].facetAddressPosition = facetAddressPosition;
            }
            ds.facetAddresses.pop();
            delete ds.facetFunctionSelectors[_facet].facetAddressPosition;
        }
    }

    function _initializeDiamondCut(address _init, bytes memory _calldata) internal {
        if (_init == address(0)) {
            if (_calldata.length != 0) revert InitAddressZeroButCalldataNotEmpty();
            return;
        }
        _enforceHasContractCode(_init);
        (bool success, bytes memory error) = _init.delegatecall(_calldata);
        if (!success) {
            if (error.length > 0) {
                assembly {
                    revert(add(error, 0x20), mload(error))
                }
            }
            revert InitFunctionReverted();
        }
    }

    function _enforceHasContractCode(address _contract) internal view {
        if (_contract.code.length == 0) revert NoBytecodeAtAddress(_contract);
    }
}
