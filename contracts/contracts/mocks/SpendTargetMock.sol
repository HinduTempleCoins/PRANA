// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only target for KeeperGatedVault. Records every call so tests can assert that in
///         paper-trade mode the vault NEVER reaches this contract (calls stays 0), and in live
///         mode it does. It moves no tokens itself; token outflow in tests is driven by allowing
///         the ERC-20's own `transfer` selector (target = token), which the balance-delta meter
///         then charges. Distinct selectors let allowlist scoping be exercised.
contract SpendTargetMock {
    uint256 public calls;
    address public lastCaller;
    uint256 public lastValue;
    bytes public lastData;

    event Hit(address caller, uint256 value, bytes data);

    /// @dev "allowed" selector in tests.
    function doThing(uint256 n) external payable {
        calls += 1;
        lastCaller = msg.sender;
        lastValue = msg.value;
        lastData = msg.data;
        n;
        emit Hit(msg.sender, msg.value, msg.data);
    }

    /// @dev a DIFFERENT selector — used to test out-of-scope (non-allowlisted) rejection.
    function otherThing(uint256 n) external payable {
        calls += 1;
        n;
    }

    receive() external payable {}
}
