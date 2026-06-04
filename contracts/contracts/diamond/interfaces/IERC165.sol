// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IERC165 — standard interface detection (ERC-165).
interface IERC165 {
    /// @notice True if this contract implements the interface defined by `interfaceId`.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
