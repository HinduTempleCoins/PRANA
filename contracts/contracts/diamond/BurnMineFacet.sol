// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LibDiamond} from "./LibDiamond.sol";

/// @title BurnMineFacet — demo facet proving facets share ONE state through the diamond.
/// @notice A toy "burn mine": callers burn (here, simply account) an input amount and the facet
///         mints a meshed output credit. The point of the demo is the storage model — this facet
///         keeps its OWN namespaced struct (the "Diamond Storage" pattern), distinct from
///         {LibDiamond}'s frozen routing struct, yet ANY facet delegatecalled by the same diamond
///         can read/write it. That is the "shared-mesh-storage" the burn-mine mesh is built on:
///         one mine's output feeds the next because they all see the same slot.
/// @dev Namespaced at keccak256("prana.diamond.burnmine.storage") so it never collides with
///      LibDiamond's slot or any other facet's variables.
contract BurnMineFacet {
    /// @dev Distinct from LibDiamond's slot — proves facets can append independent shared state.
    bytes32 internal constant BURN_MINE_STORAGE_POSITION =
        keccak256("prana.diamond.burnmine.storage");

    /// @notice The mine's shared accounting, visible to every facet on this diamond.
    /// @param totalBurned Cumulative input accounted across all callers.
    /// @param totalMinted Cumulative meshed output credited.
    /// @param ratioNum Output numerator (minted = burned * num / den).
    /// @param ratioDen Output denominator.
    /// @param minted Per-account output credit (the value the next mine in a mesh would read).
    struct BurnMineStorage {
        uint256 totalBurned;
        uint256 totalMinted;
        uint256 ratioNum;
        uint256 ratioDen;
        mapping(address => uint256) minted;
    }

    event MineConfigured(uint256 ratioNum, uint256 ratioDen);
    event Mined(address indexed account, uint256 burned, uint256 minted);

    error NotConfigured();
    error ZeroAmount();
    error BadRatio();

    /// @notice Anchor the facet's namespaced storage.
    function _bmStorage() internal pure returns (BurnMineStorage storage bms) {
        bytes32 position = BURN_MINE_STORAGE_POSITION;
        assembly {
            bms.slot := position
        }
    }

    /// @notice Owner-gated: set the burn->mint ratio. Gated on the SAME owner the diamond uses,
    ///         demonstrating this facet reads LibDiamond's ownership through shared storage.
    function configureMine(uint256 _ratioNum, uint256 _ratioDen) external {
        LibDiamond.enforceIsContractOwner();
        if (_ratioNum == 0 || _ratioDen == 0) revert BadRatio();
        BurnMineStorage storage bms = _bmStorage();
        bms.ratioNum = _ratioNum;
        bms.ratioDen = _ratioDen;
        emit MineConfigured(_ratioNum, _ratioDen);
    }

    /// @notice Account a burn of `_amount` and credit meshed output to the caller.
    function mine(uint256 _amount) external {
        if (_amount == 0) revert ZeroAmount();
        BurnMineStorage storage bms = _bmStorage();
        if (bms.ratioDen == 0) revert NotConfigured();
        uint256 out = (_amount * bms.ratioNum) / bms.ratioDen;
        bms.totalBurned += _amount;
        bms.totalMinted += out;
        bms.minted[msg.sender] += out;
        emit Mined(msg.sender, _amount, out);
    }

    /// @notice The caller-or-account meshed output credit (what a downstream mine would feed on).
    function mintedOf(address _account) external view returns (uint256) {
        return _bmStorage().minted[_account];
    }

    /// @notice Cumulative burned input across the whole diamond's mesh.
    function totalBurned() external view returns (uint256) {
        return _bmStorage().totalBurned;
    }

    /// @notice Cumulative meshed output minted across the whole diamond's mesh.
    function totalMinted() external view returns (uint256) {
        return _bmStorage().totalMinted;
    }
}
