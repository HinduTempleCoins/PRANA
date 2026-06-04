// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AggregatorV3Interface} from "../ChainlinkPriceAdapter.sol";

/// @notice Settable Chainlink-style aggregator for tests: configurable decimals, answer,
///         updatedAt, and round bookkeeping so staleness / incomplete-round paths can be exercised.
contract MockAggregatorV3 is AggregatorV3Interface {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        _decimals = decimals_;
        _answer = answer_;
        _updatedAt = updatedAt_;
        _roundId = 1;
        _answeredInRound = 1;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _answeredInRound);
    }

    /// @notice Set the answer/updatedAt and bump the round id.
    function setAnswer(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
        _roundId += 1;
        _answeredInRound = _roundId;
    }

    /// @notice Force an incomplete round (answeredInRound < roundId).
    function setIncompleteRound() external {
        _roundId += 1; // roundId now ahead of _answeredInRound
    }
}
