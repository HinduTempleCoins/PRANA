// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PausableGuardian} from "../PausableGuardian.sol";
import {IMessageTransport} from "../interfaces/IMessageTransport.sol";

/// @title MessagingBridgeAdapter (BI5) — generic cross-chain messaging adapter over a swappable
///        transport.
///
/// @notice A protocol-agnostic messaging layer for the bridge/router. The concrete cross-chain
///         messaging protocol (Hyperlane / LayerZero / Axelar / Wormhole / CCIP / a native
///         light-client / …) is a USER DECISION (UD-BI-A) and is NOT hard-picked here. This adapter
///         talks ONLY to {IMessageTransport}; a thin per-protocol shim implements that interface and
///         is injected at deploy time and swappable by admin.
///
///         FLOW:
///         - A consumer (a bridge endpoint / router) registered via {setConsumer} calls
///           {sendMessage}: the adapter wraps the consumer's `payload` in an envelope (tagging the
///           origin consumer + a per-consumer outbound nonce) and hands it to the transport.
///         - On the destination chain, the transport delivers the envelope; whoever the transport
///           authorizes calls {receiveMessage} with the transport's `proof`. The adapter asks the
///           transport to {validateInbound}, enforces PER-MESSAGE replay protection over the envelope
///           hash, then dispatches the inner payload to the registered destination consumer.
///
/// @dev    The adapter owns NO token logic — it is pure message plumbing. Trust in delivery comes
///         from whatever security model the chosen {IMessageTransport} carries (UD-BI-A). The adapter
///         adds: consumer allow-listing, envelope tagging, and replay protection independent of the
///         transport's own dedup.
interface IMessageConsumer {
    /// @notice Handle an inbound cross-chain payload that the adapter has authenticated.
    /// @param srcChainId transport domain id the message came from.
    /// @param payload    the inner consumer payload (envelope already stripped).
    function onBridgeMessage(uint256 srcChainId, bytes calldata payload) external;
}

contract MessagingBridgeAdapter is PausableGuardian, ReentrancyGuard {
    /// @notice Role allowed to call {sendMessage} (the bridge endpoints / routers).
    bytes32 public constant CONSUMER_ROLE = keccak256("CONSUMER_ROLE");

    /// @notice Domain tag baked into the envelope.
    string public constant DOMAIN = "PRANA.MessagingBridgeAdapter.v1";

    /// @notice The swappable concrete transport. Admin-settable (UD-BI-A choice lives behind it).
    IMessageTransport public transport;

    /// @notice Destination consumer to dispatch inbound messages of a given `consumerKey` to.
    ///         consumerKey is an app-chosen tag (e.g. keccak("PolygonLink")) so multiple bridge apps
    ///         can share one adapter without colliding.
    mapping(bytes32 => address) public inboundConsumer;

    /// @notice Per-consumerKey outbound nonce (envelope uniqueness).
    mapping(bytes32 => uint256) public outboundNonce;

    /// @notice Per-MESSAGE replay guard over the inbound envelope hash.
    mapping(bytes32 => bool) public consumedEnvelope;

    // --- events ------------------------------------------------------------
    event TransportSet(address indexed transport);
    event InboundConsumerSet(bytes32 indexed consumerKey, address indexed consumer);
    event MessageSent(
        bytes32 indexed envelopeHash,
        bytes32 indexed consumerKey,
        uint256 indexed dstChainId,
        uint256 nonce,
        bytes32 transportMessageId
    );
    event MessageReceived(
        bytes32 indexed envelopeHash,
        bytes32 indexed consumerKey,
        uint256 indexed srcChainId,
        address consumer
    );

    // --- errors ------------------------------------------------------------
    error ZeroAddress();
    error TransportNotSet();
    error UnknownConsumer(bytes32 consumerKey);
    error EnvelopeAlreadyConsumed(bytes32 envelopeHash);
    error InboundNotProven();
    error BadEnvelope();

    /// @param unpauseDelay_ timelock (seconds) before a proposed unpause can execute.
    /// @param admin_ receives DEFAULT_ADMIN_ROLE + GUARDIAN_ROLE.
    /// @param transport_ initial transport shim (may be set later, but must be non-zero here).
    constructor(uint256 unpauseDelay_, address admin_, address transport_)
        PausableGuardian(unpauseDelay_, admin_)
    {
        if (admin_ == address(0) || transport_ == address(0)) revert ZeroAddress();
        transport = IMessageTransport(transport_);
        emit TransportSet(transport_);
    }

    // =======================================================================
    //                          ADMIN CONFIG
    // =======================================================================

    /// @notice Swap the concrete messaging transport (the UD-BI-A choice). Admin-only.
    function setTransport(address transport_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (transport_ == address(0)) revert ZeroAddress();
        transport = IMessageTransport(transport_);
        emit TransportSet(transport_);
    }

    /// @notice Register the destination consumer that inbound messages of `consumerKey` dispatch to.
    /// @dev    Set to address(0) to disable a key.
    function setInboundConsumer(bytes32 consumerKey, address consumer)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        inboundConsumer[consumerKey] = consumer;
        emit InboundConsumerSet(consumerKey, consumer);
    }

    /// @notice Grant a bridge endpoint the right to call {sendMessage}.
    function grantConsumer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(CONSUMER_ROLE, account);
    }

    // =======================================================================
    //                       OUTBOUND (consumer -> transport)
    // =======================================================================

    /// @notice Send `payload` to `dstChainId` (transport domain) under `consumerKey`. Wraps it in a
    ///         tagged, nonce'd envelope and hands it to the transport. Forwards `msg.value` as the
    ///         transport relay fee.
    /// @return envelopeHash the deterministic hash of the sent envelope (matches the inbound side).
    /// @return transportMessageId the transport's opaque tracking id.
    function sendMessage(bytes32 consumerKey, uint256 dstChainId, bytes calldata payload)
        external
        payable
        whenNotPaused
        nonReentrant
        onlyRole(CONSUMER_ROLE)
        returns (bytes32 envelopeHash, bytes32 transportMessageId)
    {
        if (address(transport) == address(0)) revert TransportNotSet();

        uint256 nonce = outboundNonce[consumerKey]++;
        bytes memory envelope = abi.encode(DOMAIN, consumerKey, block.chainid, dstChainId, nonce, payload);
        envelopeHash = keccak256(envelope);

        transportMessageId = transport.sendMessage{value: msg.value}(dstChainId, envelope);
        emit MessageSent(envelopeHash, consumerKey, dstChainId, nonce, transportMessageId);
    }

    /// @notice Quote the transport fee for an outbound envelope (so callers forward exact value).
    function quoteSend(bytes32 consumerKey, uint256 dstChainId, bytes calldata payload)
        external
        view
        returns (uint256 fee)
    {
        uint256 nonce = outboundNonce[consumerKey];
        bytes memory envelope = abi.encode(DOMAIN, consumerKey, block.chainid, dstChainId, nonce, payload);
        return transport.quoteFee(dstChainId, envelope);
    }

    // =======================================================================
    //                    INBOUND (transport -> consumer)
    // =======================================================================

    /// @notice Deliver an inbound envelope. Anyone the transport authorizes may call this. The
    ///         adapter authenticates via {IMessageTransport.validateInbound}, enforces per-envelope
    ///         replay protection, strips the envelope, and dispatches the inner payload to the
    ///         registered consumer.
    /// @param srcChainId transport domain the message came from.
    /// @param envelope   the full tagged envelope as produced by {sendMessage} on the far side.
    /// @param proof      transport-specific delivery proof (opaque here).
    function receiveMessage(uint256 srcChainId, bytes calldata envelope, bytes calldata proof)
        external
        whenNotPaused
        nonReentrant
    {
        if (address(transport) == address(0)) revert TransportNotSet();

        // Transport attests the envelope genuinely arrived from srcChainId.
        if (!transport.validateInbound(srcChainId, envelope, proof)) revert InboundNotProven();

        bytes32 envelopeHash = keccak256(envelope);
        if (consumedEnvelope[envelopeHash]) revert EnvelopeAlreadyConsumed(envelopeHash);

        // Decode + sanity-check the envelope. `originChainId` and `nonce` are tagged into the
        // envelope hash (replay identity / off-chain audit) and not otherwise needed here, so they
        // are skipped via empty tuple positions to avoid unused locals.
        (
            string memory domain,
            bytes32 consumerKey,
            ,
            uint256 dstChainId,
            ,
            bytes memory payload
        ) = abi.decode(envelope, (string, bytes32, uint256, uint256, uint256, bytes));

        if (keccak256(bytes(domain)) != keccak256(bytes(DOMAIN))) revert BadEnvelope();
        // The envelope's declared destination must reference THIS chain. `dstChainId` is a TRANSPORT
        // domain id (UD-BI-A: numbering is protocol-specific), so we accept either a literal EVM
        // chain-id match or the transport's own inbound domain echo (`srcChainId`).
        if (dstChainId != block.chainid && dstChainId != srcChainId) revert BadEnvelope();

        address consumer = inboundConsumer[consumerKey];
        if (consumer == address(0)) revert UnknownConsumer(consumerKey);

        consumedEnvelope[envelopeHash] = true;
        IMessageConsumer(consumer).onBridgeMessage(srcChainId, payload);

        emit MessageReceived(envelopeHash, consumerKey, srcChainId, consumer);
    }
}
