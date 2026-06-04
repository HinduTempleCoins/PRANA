// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only call target for AA execute() tests. Records the last caller, value, and a
///         stored number; exposes distinct selectors so session-key scope checks have something
///         in/out of scope to exercise.
contract CallTargetMock {
    address public lastCaller;
    uint256 public lastValue;
    uint256 public stored;
    uint256 public pings;

    event Pinged(address caller, uint256 value, uint256 n);

    /// @dev selector used as the "allowed" session target method.
    function setNumber(uint256 n) external payable {
        lastCaller = msg.sender;
        lastValue = msg.value;
        stored = n;
        emit Pinged(msg.sender, msg.value, n);
    }

    /// @dev a DIFFERENT selector — used to test out-of-scope rejection.
    function forbidden(uint256 n) external payable {
        stored = n;
    }

    function ping() external payable {
        lastCaller = msg.sender;
        lastValue = msg.value;
        pings += 1;
    }

    receive() external payable {
        lastCaller = msg.sender;
        lastValue = msg.value;
    }
}
