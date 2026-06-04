// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IRandomnessSource, IRandomnessConsumer} from "../interfaces/IRandomnessSource.sol";
import {WeightedRandomDraw} from "../lib/WeightedRandomDraw.sol";

/// @title LocalRandomMock
/// @notice Test/dev stand-in for a VRF: a deterministic, seedable {IRandomnessSource}.
/// @dev Each request gets a reproducible entropy word derived from the configured seed and a
///      monotonic counter, so the same seed yields the same sequence across runs — ideal for
///      statistical distribution tests with no flakiness. Fulfillment can be auto (in the
///      same call) or deferred to mimic the async VRF callback shape. Also re-exports the
///      {WeightedRandomDraw} pure helpers so library behaviour can be unit-tested directly.
contract LocalRandomMock is IRandomnessSource {
    using WeightedRandomDraw for uint256[];

    /// @notice Seed mixed into every derived entropy word.
    uint256 public seed;
    /// @notice Monotonic request counter; doubles as the requestId source.
    uint256 public nonce;

    /// @dev requestId => derived entropy word (set on request, consumed on fulfill).
    mapping(uint256 => uint256) public wordOf;

    constructor(uint256 seed_) {
        seed = seed_;
    }

    /// @notice Reseed the generator (resets reproducible sequence base, not the counter).
    function setSeed(uint256 seed_) external {
        seed = seed_;
    }

    /// @inheritdoc IRandomnessSource
    function requestRandomness() external returns (uint256 requestId) {
        requestId = nonce++;
        uint256 word = _derive(requestId);
        wordOf[requestId] = word;
        emit RandomnessRequested(requestId, msg.sender);
    }

    /// @notice Deliver a previously-requested word to `consumer` (mimics the async callback).
    function fulfill(address consumer, uint256 requestId) external {
        uint256 word = wordOf[requestId];
        emit RandomnessFulfilled(requestId, word);
        IRandomnessConsumer(consumer).rawFulfillRandomness(requestId, word);
    }

    /// @notice The reproducible entropy word for a given request id under the current seed.
    function peek(uint256 requestId) external view returns (uint256) {
        return _derive(requestId);
    }

    /// @notice The next entropy word that {requestRandomness} would produce, without mutating.
    function nextWord() external view returns (uint256) {
        return _derive(nonce);
    }

    /// @dev Deterministic word = keccak(seed, requestId). Reproducible for a fixed seed.
    function _derive(uint256 requestId) internal view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(seed, requestId)));
    }

    // ------------------------------------------------------------------ //
    //  Library passthroughs (so WeightedRandomDraw can be unit-tested)   //
    // ------------------------------------------------------------------ //

    function draw(uint256[] memory weights, uint256 entropy) external pure returns (uint256) {
        return WeightedRandomDraw.draw(weights, entropy);
    }

    function cumulative(uint256[] memory weights) external pure returns (uint256[] memory) {
        return WeightedRandomDraw.cumulative(weights);
    }

    function drawFromCumulative(uint256[] memory cum, uint256 entropy)
        external
        pure
        returns (uint256)
    {
        return WeightedRandomDraw.drawFromCumulative(cum, entropy);
    }

    function entropyAt(uint256 baseWord, uint256 n) external pure returns (uint256) {
        return WeightedRandomDraw.entropyAt(baseWord, n);
    }
}
