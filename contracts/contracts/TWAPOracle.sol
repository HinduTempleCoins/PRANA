// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TWAPOracle
/// @notice Manipulation-resistant time-weighted average price accumulator.
/// @dev An authorized `updater` pushes spot prices via `update`. Each update
///      accumulates the previous price weighted by the elapsed time, building a
///      cumulative value. A caller snapshots `priceCumulative()` and
///      `lastUpdate()` at some point, then later calls `consult` with that
///      snapshot to recover the average price over the intervening window.
///      Because the average is taken over real elapsed time, a momentary price
///      spike has weight proportional only to how long it persisted, making the
///      result resistant to single-block manipulation.
contract TWAPOracle {
    /// @notice The only address permitted to call `update`.
    address public immutable updater;

    /// @notice The most recently reported spot price.
    uint256 public lastPrice;

    /// @notice Timestamp of the most recent `update`.
    uint64 public lastUpdate;

    /// @notice Running sum of price * elapsedSeconds across all updates.
    uint256 public priceCumulative;

    event Updated(uint256 indexed price, uint64 timestamp, uint256 priceCumulative);

    error NotUpdater();
    error NoTimeElapsed();

    /// @param _updater Address authorized to push price updates.
    constructor(address _updater) {
        require(_updater != address(0), "updater=0");
        updater = _updater;
        lastUpdate = uint64(block.timestamp);
    }

    /// @notice Accumulate the standing price over the time since the last update,
    ///         then record `price` as the new standing price.
    /// @param price The current spot price (in arbitrary fixed units).
    function update(uint256 price) external {
        if (msg.sender != updater) revert NotUpdater();

        uint64 nowTs = uint64(block.timestamp);
        uint256 elapsed = uint256(nowTs - lastUpdate);

        // Weight the *previous* price by the time it was in force.
        priceCumulative += lastPrice * elapsed;

        lastPrice = price;
        lastUpdate = nowTs;

        emit Updated(price, nowTs, priceCumulative);
    }

    /// @notice Compute the time-weighted average price since a prior snapshot.
    /// @dev The caller is expected to have read `priceCumulative()` and
    ///      `lastUpdate()` at the snapshot point. To capture the full window up
    ///      to "now", an `update` should occur at or after the consult time so
    ///      the current cumulative reflects elapsed time.
    /// @param sinceTimestamp The `lastUpdate` value captured at the snapshot.
    /// @param sinceCumulative The `priceCumulative` value captured at the snapshot.
    /// @return twap The time-weighted average price over the window.
    function consult(uint64 sinceTimestamp, uint256 sinceCumulative)
        external
        view
        returns (uint256 twap)
    {
        uint64 endTs = lastUpdate;
        if (endTs <= sinceTimestamp) revert NoTimeElapsed();

        uint256 window = uint256(endTs - sinceTimestamp);
        twap = (priceCumulative - sinceCumulative) / window;
    }
}
