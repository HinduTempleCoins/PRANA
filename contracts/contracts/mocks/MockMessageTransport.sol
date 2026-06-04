// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMessageTransport} from "../interfaces/IMessageTransport.sol";

/// @notice Test-only {IMessageTransport}: records the last sent message, returns a deterministic id,
///         and lets tests toggle inbound validity / fee. Stands in for a Hyperlane/LayerZero/etc.
///         shim (the UD-BI-A choice) so {MessagingBridgeAdapter} can be exercised without a real
///         cross-chain protocol. TEST ONLY.
contract MockMessageTransport is IMessageTransport {
    uint256 public lastDstChainId;
    bytes public lastPayload;
    uint256 public sendCount;
    uint256 public feeWei;
    bool public inboundValid = true;
    uint256 public lastValueReceived;

    event Sent(uint256 dstChainId, bytes payload, bytes32 messageId, uint256 value);

    function setFee(uint256 fee_) external {
        feeWei = fee_;
    }

    function setInboundValid(bool ok) external {
        inboundValid = ok;
    }

    function sendMessage(uint256 dstChainId, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId)
    {
        lastDstChainId = dstChainId;
        lastPayload = payload;
        lastValueReceived = msg.value;
        messageId = keccak256(abi.encode(dstChainId, payload, sendCount));
        sendCount++;
        emit Sent(dstChainId, payload, messageId, msg.value);
    }

    function quoteFee(uint256, bytes calldata) external view returns (uint256) {
        return feeWei;
    }

    function validateInbound(uint256, bytes calldata, bytes calldata) external view returns (bool) {
        return inboundValid;
    }
}
