// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IEmissionPhaseView} from "../interfaces/IEmissionPhaseView.sol";

/// @notice Test-only emission-phase source: lets tests drive `currentEpoch()` to exercise the
///         bootstrap-vs-steady phase taper in CountercyclicalFeeOracle.
contract MockEmissionPhase is IEmissionPhaseView {
    uint64 public epoch;

    function setEpoch(uint64 e) external {
        epoch = e;
    }

    function currentEpoch() external view returns (uint64) {
        return epoch;
    }
}
