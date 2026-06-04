// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only inbound consumer for {MessagingBridgeAdapter}: records the last delivered
///         payload + source chain so tests can assert dispatch happened. TEST ONLY.
contract MockMessageConsumer {
    uint256 public lastSrcChainId;
    bytes public lastPayload;
    uint256 public callCount;

    event Received(uint256 srcChainId, bytes payload);

    function onBridgeMessage(uint256 srcChainId, bytes calldata payload) external {
        lastSrcChainId = srcChainId;
        lastPayload = payload;
        callCount++;
        emit Received(srcChainId, payload);
    }
}
