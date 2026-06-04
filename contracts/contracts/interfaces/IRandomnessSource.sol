// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IRandomnessSource
/// @notice VRF-shaped randomness interface shared by gacha / farm / arcade modules.
/// @dev Models the request/fulfill pattern of a verifiable randomness oracle: a consumer
///      calls {requestRandomness} and is later delivered a 256-bit entropy word via the
///      {IRandomnessConsumer-rawFulfillRandomness} callback. A local mock implementation can
///      stand in for a real VRF during development; production wires this to an on-chain VRF.
interface IRandomnessSource {
    /// @notice Emitted when a consumer requests a random word.
    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    /// @notice Emitted when a request is fulfilled with its entropy word.
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);

    /// @notice Request a single random word. The source later calls back the consumer.
    /// @return requestId Opaque id used to correlate the eventual fulfillment.
    function requestRandomness() external returns (uint256 requestId);
}

/// @title IRandomnessConsumer
/// @notice Callback surface a randomness source invokes to deliver entropy.
interface IRandomnessConsumer {
    /// @notice Delivers the entropy word for a previously-issued `requestId`.
    /// @dev MUST only be callable by the trusted randomness source.
    function rawFulfillRandomness(uint256 requestId, uint256 randomWord) external;
}
