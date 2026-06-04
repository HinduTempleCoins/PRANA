// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IMessageTransport — swappable cross-chain messaging transport abstraction.
///
/// @notice The concrete cross-chain messaging protocol (Hyperlane, LayerZero, Axelar, Wormhole,
///         Chainlink CCIP, a native light-client, …) is a USER DECISION (UD-BI-A) and is therefore
///         NOT hard-picked anywhere in the bridge code. {MessagingBridgeAdapter} talks ONLY to this
///         interface; a thin per-protocol shim implements it and is injected at deploy time. Swapping
///         protocols = deploying a new shim and pointing the adapter at it — no adapter redeploy of
///         business logic.
///
/// @dev    Two directions:
///         - OUTBOUND: the adapter calls {sendMessage}; the transport relays `payload` to `dstChainId`
///           and returns an opaque `messageId` for tracking.
///         - INBOUND: the transport (or a relayer it authorizes) calls back into the adapter, which
///           in turn calls {validateInbound} so the transport can attest that `payload` genuinely
///           arrived from `srcChainId` (carrying its own proof/security model behind `proof`).
///
///         `chainId` here is the TRANSPORT's domain identifier, which is NOT necessarily the EVM
///         chain id — many protocols use their own domain numbering. The adapter maps EVM chain ids
///         to transport domains via its own config.
interface IMessageTransport {
    /// @notice Dispatch `payload` to `dstChainId` (a transport domain id). Returns an opaque id the
    ///         transport assigns to the message for off-chain tracking / dedup.
    /// @dev    MAY be payable in concrete shims (protocols charge a relay fee); the adapter forwards
    ///         `msg.value`. Declared payable so fee-charging transports work without an interface change.
    function sendMessage(uint256 dstChainId, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId);

    /// @notice Quote the native-token fee required to send `payload` to `dstChainId`. 0 if free.
    /// @dev    Callers SHOULD quote then forward exactly this much value to {sendMessage}.
    function quoteFee(uint256 dstChainId, bytes calldata payload)
        external
        view
        returns (uint256 fee);

    /// @notice Verify that `payload` was genuinely delivered from `srcChainId` under `proof`.
    /// @dev    The proof format is transport-specific and opaque to the adapter. Implementations MUST
    ///         revert (or return false) for an unproven/forged message. Implementations that deliver
    ///         via a trusted push (the transport itself calls the adapter) MAY simply check
    ///         `msg.sender == address(thisTransport)` and ignore `proof`.
    function validateInbound(uint256 srcChainId, bytes calldata payload, bytes calldata proof)
        external
        view
        returns (bool);
}
