// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IERC173 — contract ownership standard.
/// @notice The diamond's ownership surface; cut/upgrade is gated on this owner via LibDiamond.
interface IERC173 {
    /// @notice Emitted when ownership is transferred.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice The current owner.
    function owner() external view returns (address owner_);

    /// @notice Transfer ownership to `_newOwner` (owner-gated).
    function transferOwnership(address _newOwner) external;
}
