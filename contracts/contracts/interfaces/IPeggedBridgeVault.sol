// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IPeggedBridgeVault — a single-custodian lock/release or burn/mint bridge endpoint.
/// @notice External surface of {PeggedBridgeVault}: per-token mode (LOCK_RELEASE or BURN_MINT),
///         outbound lock/burn that emits a nonce'd bridge message, and custodian-only inbound
///         release/mint with replay protection and a rolling daily cap.
/// @dev NOTE: this is a trusted-custodian PLACEHOLDER, to be replaced by an audited two-way
///      light-client / multi-attester bridge in production. Interface mirrors the placeholder.
interface IPeggedBridgeVault {
    enum Mode {
        UNSET,
        LOCK_RELEASE,
        BURN_MINT
    }

    event ModeSet(address indexed token, Mode mode);
    event DailyCapSet(address indexed token, uint256 cap);
    event BridgeLocked(address indexed token, address indexed from, uint256 amount, bytes32 destinationRef, uint256 nonce);
    event BridgeBurned(address indexed token, address indexed from, uint256 amount, bytes32 destinationRef, uint256 nonce);
    event BridgeReleased(address indexed token, address indexed to, uint256 amount, bytes32 sourceRef, uint256 nonce);
    event BridgeMinted(address indexed token, address indexed to, uint256 amount, bytes32 sourceRef, uint256 nonce);

    function CUSTODIAN_ROLE() external view returns (bytes32);
    function modeOf(address token) external view returns (Mode);
    function outboundNonce() external view returns (uint256);
    function usedInboundNonce(uint256 nonce) external view returns (bool);
    function dailyCap(address token) external view returns (uint256);
    function releasedInWindow(address token) external view returns (uint256);
    function windowStart(address token) external view returns (uint256);

    // --- admin ------------------------------------------------------------ //
    function setMode(address token, Mode mode) external;
    function setDailyCap(address token, uint256 cap) external;

    // --- outbound (anyone) ------------------------------------------------ //
    function lockForBridge(address token, uint256 amount, bytes32 destinationRef) external returns (uint256 nonce);
    function burnForBridge(address token, uint256 amount, bytes32 destinationRef) external returns (uint256 nonce);

    // --- inbound (custodian) ---------------------------------------------- //
    function releaseFromBridge(
        address token,
        address recipient,
        uint256 amount,
        bytes32 sourceRef,
        uint256 nonce
    ) external;
    function mintFromBridge(
        address token,
        address recipient,
        uint256 amount,
        bytes32 sourceRef,
        uint256 nonce
    ) external;
}
