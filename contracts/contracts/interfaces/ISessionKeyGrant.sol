// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ISessionKeyGrant — scoped, capped, expiring authorizations
/// @notice External surface of the session-key grant ledger: an account grants a session key
///         permission to call one (target, selector) up to a spend cap, until an expiry.
interface ISessionKeyGrant {
    event Granted(address indexed account, address indexed key, address target, bytes4 selector, uint256 cap, uint64 expiry);
    event Revoked(address indexed account, address indexed key);
    event Consumed(address indexed account, address indexed key, uint256 amount, uint256 spent);

    function grants(address account, address key)
        external
        view
        returns (address target, bytes4 selector, uint256 cap, uint256 spent, uint64 expiry, bool active);

    function grant(address key, address target, bytes4 selector, uint256 cap, uint64 expiry) external;
    function revoke(address key) external;

    function check(address account, address key, address target, bytes4 selector, uint256 amount)
        external
        view
        returns (bool);

    /// @notice Record spend after an authorized action. Caller must pass check().
    function consume(address account, address key, address target, bytes4 selector, uint256 amount) external;

    function remaining(address account, address key) external view returns (uint256);
}
