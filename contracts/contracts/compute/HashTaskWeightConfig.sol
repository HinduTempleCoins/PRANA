// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IHashTaskWeightConfig} from "../interfaces/IHashTaskWeightConfig.sol";
import {IUnifiedSharesLedger} from "../interfaces/IUnifiedSharesLedger.sol";

/// @title HashTaskWeightConfig (NN5) — DAO-governed lane weights + vardiff bounds for the unified pool.
/// @notice The chain-as-pool reads each lane's pooling weight from here. By default HASH and TASK are
///         BOTH 1e18 (1x) — a hashed microhash-heartbeat share and an AI-tasking share are worth the
///         same, which is what makes the switching engine "seamless". BURN (proof-of-burn perma-stake)
///         also defaults to 1e18 but is expected to be governed down/up by the DAO. The 1:1 HASH:TASK
///         default is the RECOMMENDED value; the final ratio is a user/governance decision — every
///         weight is settable by the WEIGHT_ADMIN_ROLE (held by the DAO timelock in production).
/// @dev    Also stores vardiff (variable-difficulty) min/max bounds purely as a governed on-chain
///         read for the OFF-CHAIN HASH-lane coordinator — this contract does no difficulty math.
contract HashTaskWeightConfig is AccessControl, IHashTaskWeightConfig {
    /// @notice Role that may set lane weights and vardiff bounds (the DAO timelock in production).
    bytes32 public constant WEIGHT_ADMIN_ROLE = keccak256("WEIGHT_ADMIN_ROLE");

    /// @notice 1e18 = 1x weight (shares pooled at face value).
    uint256 public constant WEIGHT_ONE = 1e18;

    /// @dev lane => pooling weight (1e18 = 1x).
    mapping(IUnifiedSharesLedger.Lane => uint256) private _laneWeight;

    uint256 private _minDifficulty;
    uint256 private _maxDifficulty;

    error InvalidVardiffBounds();

    /// @param admin           DEFAULT_ADMIN_ROLE + WEIGHT_ADMIN_ROLE holder (DAO timelock in prod).
    /// @param burnWeight      Initial BURN-lane weight (1e18 = 1x). HASH and TASK are pinned to 1e18.
    /// @param minDifficulty_  Initial vardiff floor (coordinator hint; 0 allowed).
    /// @param maxDifficulty_  Initial vardiff ceiling (coordinator hint; must be >= floor).
    constructor(address admin, uint256 burnWeight, uint256 minDifficulty_, uint256 maxDifficulty_) {
        if (maxDifficulty_ < minDifficulty_) revert InvalidVardiffBounds();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WEIGHT_ADMIN_ROLE, admin);

        // Seamless-switching default: HASH and TASK both 1x.
        _laneWeight[IUnifiedSharesLedger.Lane.HASH] = WEIGHT_ONE;
        _laneWeight[IUnifiedSharesLedger.Lane.TASK] = WEIGHT_ONE;
        _laneWeight[IUnifiedSharesLedger.Lane.BURN] = burnWeight;
        emit LaneWeightSet(IUnifiedSharesLedger.Lane.HASH, WEIGHT_ONE);
        emit LaneWeightSet(IUnifiedSharesLedger.Lane.TASK, WEIGHT_ONE);
        emit LaneWeightSet(IUnifiedSharesLedger.Lane.BURN, burnWeight);

        _minDifficulty = minDifficulty_;
        _maxDifficulty = maxDifficulty_;
        emit VardiffBoundsSet(minDifficulty_, maxDifficulty_);
    }

    // --- governed setters ---

    /// @notice Set a lane's pooling weight (1e18 = 1x). Any lane is settable; default HASH:TASK is 1:1.
    function setLaneWeight(IUnifiedSharesLedger.Lane lane, uint256 weight) external onlyRole(WEIGHT_ADMIN_ROLE) {
        _laneWeight[lane] = weight;
        emit LaneWeightSet(lane, weight);
    }

    /// @notice Set the vardiff floor/ceiling the off-chain coordinator clamps per-worker difficulty to.
    function setVardiffBounds(uint256 minDifficulty_, uint256 maxDifficulty_) external onlyRole(WEIGHT_ADMIN_ROLE) {
        if (maxDifficulty_ < minDifficulty_) revert InvalidVardiffBounds();
        _minDifficulty = minDifficulty_;
        _maxDifficulty = maxDifficulty_;
        emit VardiffBoundsSet(minDifficulty_, maxDifficulty_);
    }

    // --- views (IHashTaskWeightConfig) ---

    function laneWeight(IUnifiedSharesLedger.Lane lane) external view returns (uint256) {
        return _laneWeight[lane];
    }

    function minDifficulty() external view returns (uint256) {
        return _minDifficulty;
    }

    function maxDifficulty() external view returns (uint256) {
        return _maxDifficulty;
    }
}
