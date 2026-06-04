// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IGaugeController — ve-weighted emission direction (Curve model, simplified)
/// @notice External surface of the gauge controller: ve-lockers vote their weight onto gauges.
interface IGaugeController {
    event GaugeAdded(address indexed gauge);
    event Voted(address indexed user, address indexed gauge, uint256 weight);

    function ve() external view returns (address);
    function gauges(uint256 index) external view returns (address);
    function isGauge(address gauge) external view returns (bool);
    function gaugeWeight(address gauge) external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function userGauge(address user) external view returns (address);
    function userWeight(address user) external view returns (uint256);

    function addGauge(address gauge) external;

    /// @notice Move all of the caller's current ve weight to `gauge`.
    function vote(address gauge) external;

    /// @notice Gauge's share of emissions, scaled by 1e18.
    function relativeWeight(address gauge) external view returns (uint256);

    function gaugeCount() external view returns (uint256);
}
