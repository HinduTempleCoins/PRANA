// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VoteEscrow} from "./VoteEscrow.sol";

/// @title GaugeController — ve-weighted emission direction (Curve model, simplified)
/// @notice ve-lockers vote their voting weight onto a gauge (a pool/reward target). A gauge's
///         relative weight = its votes / total votes, which an emission splitter uses to direct
///         rewards. Re-voting moves a user's full weight. Weight is snapshotted at vote time
///         (a simplification of Curve's continuous bias decay) — re-vote to refresh.
contract GaugeController {
    VoteEscrow public immutable ve;

    address[] public gauges;
    mapping(address => bool) public isGauge;
    mapping(address => uint256) public gaugeWeight;
    uint256 public totalWeight;

    mapping(address => address) public userGauge;
    mapping(address => uint256) public userWeight;

    event GaugeAdded(address indexed gauge);
    event Voted(address indexed user, address indexed gauge, uint256 weight);

    constructor(VoteEscrow ve_) {
        require(address(ve_) != address(0), "ve=0");
        ve = ve_;
    }

    function addGauge(address gauge) external {
        require(gauge != address(0) && !isGauge[gauge], "bad gauge");
        isGauge[gauge] = true;
        gauges.push(gauge);
        emit GaugeAdded(gauge);
    }

    /// @notice Move all of the caller's current ve weight to `gauge`.
    function vote(address gauge) external {
        require(isGauge[gauge], "no gauge");
        address old = userGauge[msg.sender];
        if (old != address(0)) {
            gaugeWeight[old] -= userWeight[msg.sender];
            totalWeight -= userWeight[msg.sender];
        }
        uint256 w = ve.balanceOf(msg.sender);
        require(w > 0, "no ve weight");
        userGauge[msg.sender] = gauge;
        userWeight[msg.sender] = w;
        gaugeWeight[gauge] += w;
        totalWeight += w;
        emit Voted(msg.sender, gauge, w);
    }

    /// @notice Gauge's share of emissions, scaled by 1e18.
    function relativeWeight(address gauge) external view returns (uint256) {
        if (totalWeight == 0) return 0;
        return (gaugeWeight[gauge] * 1e18) / totalWeight;
    }

    function gaugeCount() external view returns (uint256) {
        return gauges.length;
    }
}
