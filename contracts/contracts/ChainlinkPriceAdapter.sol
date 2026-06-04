// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Chainlink AggregatorV3 interface (the subset this adapter consumes).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @title ChainlinkPriceAdapter — production price source backed by Chainlink-style feeds.
/// @notice Drop-in replacement for the dev SimplePriceOracle: exposes the same `price(address)`
///         view (returns a token price scaled to 1e18) so CDPVault (or any consumer) can use either.
///         Each token maps to an AggregatorV3 feed plus a per-feed `maxStaleness` window. Reads are
///         guarded with staleness + sanity checks so a frozen, negative, or incomplete round cannot
///         silently feed a stale price into downstream collateral math.
contract ChainlinkPriceAdapter {
    uint256 private constant WAD = 1e18;

    struct Feed {
        AggregatorV3Interface aggregator;
        uint256 maxStaleness; // seconds; an update older than this reverts
        uint8 decimals;       // cached aggregator decimals
    }

    mapping(address => Feed) public feeds;

    /// @param tokens       token addresses to register
    /// @param aggregators  matching Chainlink aggregator for each token
    /// @param maxStaleness matching staleness window (seconds) for each token
    constructor(
        address[] memory tokens,
        address[] memory aggregators,
        uint256[] memory maxStaleness
    ) {
        require(
            tokens.length == aggregators.length && tokens.length == maxStaleness.length,
            "length mismatch"
        );
        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i] != address(0), "token=0");
            require(aggregators[i] != address(0), "aggregator=0");
            require(maxStaleness[i] > 0, "staleness=0");
            AggregatorV3Interface agg = AggregatorV3Interface(aggregators[i]);
            feeds[tokens[i]] = Feed({
                aggregator: agg,
                maxStaleness: maxStaleness[i],
                decimals: agg.decimals()
            });
        }
    }

    /// @notice Latest price for `token`, scaled to 1e18, with staleness + sanity checks.
    /// @dev Reverts if the token is unregistered, the answer is non-positive, the round is
    ///      incomplete, or the data is older than the configured `maxStaleness`.
    function price(address token) external view returns (uint256) {
        Feed memory f = feeds[token];
        require(address(f.aggregator) != address(0), "unknown token");

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            f.aggregator.latestRoundData();

        require(answer > 0, "bad answer");
        require(updatedAt != 0 && answeredInRound >= roundId, "incomplete round");
        require(block.timestamp - updatedAt <= f.maxStaleness, "stale price");

        // Scale the feed's native decimals up/down to 1e18.
        if (f.decimals == 18) {
            return uint256(answer);
        } else if (f.decimals < 18) {
            return uint256(answer) * (10 ** (18 - f.decimals));
        } else {
            return uint256(answer) / (10 ** (f.decimals - 18));
        }
    }
}
