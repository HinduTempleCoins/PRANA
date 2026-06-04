// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IFeeRateOracle} from "../interfaces/IFeeRateOracle.sol";
import {IPriceFeedView} from "../interfaces/IPriceFeedView.sol";
import {IEmissionPhaseView} from "../interfaces/IEmissionPhaseView.sol";
import {IVerifiedMachineCounter} from "../interfaces/IVerifiedMachineCounter.sol";

/// @title CountercyclicalFeeOracle (PP2) — the rules-based, read-only Hathor fee rate.
/// @notice Computes the protocol fee rate (bps) as a PURE FUNCTION of three on-chain inputs:
///         (1) PRANA's price, (2) the emission phase, and (3) the sustained verified-machine count.
///         There is NO discretion and NO setter on the OUTPUT — Hathor is read-only here. Only the
///         curve PARAMETERS are DAO-settable (PARAM_SETTER_ROLE), and every output is hard-clamped
///         to [floorBps, ceilingBps] so a mis-set param can never escape the bounds.
///
///         The rate behaves three ways, exactly as specified:
///
///         1. COUNTERCYCLICAL in PRANA value — more fee when PRANA is cheap/abundant, less when
///            scarce/valuable. We interpolate by price between a reference-low price (fee high) and
///            a reference-high price (fee low). Below refLowPrice we pin the high end; above
///            refHighPrice we pin the low end.
///
///         2. STEPS DOWN past threshold X — while the sustained verified-machine count is below
///            `machineThresholdX`, the curve runs against the BOOTSTRAP ceiling band (up to ~5%).
///            Once X is crossed (a high, steady, verified count) it switches to the STEADY band
///            (~0.1–3%). This is a discrete step, not Hathor's choice — it is purely the counter
///            reading {IVerifiedMachineCounter.sustainedCount}.
///
///         3. PHASE TAPER (secondary) — the bootstrap band is only available during the early
///            emission phase (`bootstrapEpochs`); once emission has matured the curve uses the
///            steady band even if X has not yet been reached, so the high bootstrap fee cannot
///            persist forever. (X-crossing still takes precedence to drop to steady early.)
///
///         RECOMMENDED DEFAULTS (the exact curve/band/X is a USER decision — these are settable):
///           - steadyFloorBps   =   10  (0.10%)   steady-state lower edge
///           - steadyCeilBps    =  300  (3.00%)   steady-state upper edge
///           - bootstrapCeilBps =  500  (5.00%)   bootstrap ceiling
///           - floorBps         =   10  (0.10%)   absolute floor (cap)
///           - ceilingBps       =  500  (5.00%)   absolute ceiling (cap)
///           - machineThresholdX, refLowPrice, refHighPrice, bootstrapEpochs — set per launch plan.
///
/// @dev Stateless w.r.t. fees: holds only config. `currentRateBps()` is a deterministic view over
///      live oracle/counter/phase reads, so the settlement hook gets a fresh, tamper-evident rate.
contract CountercyclicalFeeOracle is AccessControl, IFeeRateOracle {
    /// @notice Role allowed to tune curve PARAMETERS (the DAO/timelock). Cannot set the output.
    bytes32 public constant PARAM_SETTER_ROLE = keccak256("PARAM_SETTER_ROLE");

    uint16 public constant BPS_DENOM = 10000;

    // ---- external read sources (immutable wiring) ----
    IPriceFeedView public immutable priceFeed;        // PRANA price source (1e18-scaled)
    address public immutable pranaToken;              // token whose price drives countercyclicality
    IEmissionPhaseView public immutable emission;     // emission-phase source
    IVerifiedMachineCounter public immutable counter; // sustained verified-machine count

    // ---- DAO-settable curve params (bounded; never the raw output) ----
    struct Params {
        uint16 floorBps;          // absolute floor (cap) on the output
        uint16 ceilingBps;        // absolute ceiling (cap) on the output
        uint16 steadyFloorBps;    // steady band lower edge (fee when PRANA expensive)
        uint16 steadyCeilBps;     // steady band upper edge (fee when PRANA cheap)
        uint16 bootstrapCeilBps;  // bootstrap band upper edge (fee when PRANA cheap, pre-X)
        uint256 machineThresholdX; // sustained-count at/above which we leave bootstrap → steady
        uint256 refLowPrice;      // price (1e18) at/below which fee pins to the band's HIGH edge
        uint256 refHighPrice;     // price (1e18) at/above which fee pins to the band's LOW edge
        uint64 bootstrapEpochs;   // emission epochs during which the bootstrap band is available
    }

    Params public params;

    event ParamsUpdated(Params params);

    error BadBounds();
    error BadBand();
    error BadPriceRefs();

    constructor(
        address admin,
        IPriceFeedView priceFeed_,
        address pranaToken_,
        IEmissionPhaseView emission_,
        IVerifiedMachineCounter counter_,
        Params memory params_
    ) {
        require(admin != address(0), "admin=0");
        require(
            address(priceFeed_) != address(0) &&
                pranaToken_ != address(0) &&
                address(emission_) != address(0) &&
                address(counter_) != address(0),
            "wiring=0"
        );
        priceFeed = priceFeed_;
        pranaToken = pranaToken_;
        emission = emission_;
        counter = counter_;
        _validate(params_);
        params = params_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PARAM_SETTER_ROLE, admin);
        emit ParamsUpdated(params_);
    }

    /// @notice DAO/timelock-only: replace the curve parameters. The OUTPUT remains rules-derived;
    ///         this only reshapes the curve, and is re-validated against the floor/ceiling caps.
    function setParams(Params calldata p) external onlyRole(PARAM_SETTER_ROLE) {
        _validate(p);
        params = p;
        emit ParamsUpdated(p);
    }

    /// @inheritdoc IFeeRateOracle
    /// @notice The fee rate to apply right now. Deterministic from live price / phase / count.
    function currentRateBps() public view returns (uint16) {
        Params memory p = params;

        // Which band is in force?
        //  - Past threshold X (sustained verified machines) => STEADY band, always.
        //  - Else, still inside the bootstrap emission phase => BOOTSTRAP band.
        //  - Else (phase matured but X not yet hit) => STEADY band (bootstrap can't persist).
        bool steady = counter.sustainedCount() >= p.machineThresholdX
            || uint256(emission.currentEpoch()) >= uint256(p.bootstrapEpochs);

        uint16 bandLow = p.steadyFloorBps;
        uint16 bandHigh = steady ? p.steadyCeilBps : p.bootstrapCeilBps;

        // Countercyclical interpolation by PRANA price: cheap PRANA => bandHigh, dear => bandLow.
        uint16 rate = _interpByPrice(priceFeed.price(pranaToken), p.refLowPrice, p.refHighPrice, bandLow, bandHigh);

        // Hard clamp to the absolute caps — a mis-set band can never escape [floor, ceiling].
        if (rate < p.floorBps) rate = p.floorBps;
        if (rate > p.ceilingBps) rate = p.ceilingBps;
        return rate;
    }

    /// @notice True if the curve is currently in the bootstrap regime (pre-X and within phase).
    function inBootstrap() external view returns (bool) {
        Params memory p = params;
        return counter.sustainedCount() < p.machineThresholdX
            && uint256(emission.currentEpoch()) < uint256(p.bootstrapEpochs);
    }

    // --------------------------------------------------------------------- //
    //                               internals                               //
    // --------------------------------------------------------------------- //

    /// @dev Linear interpolation that is INVERSE in price (countercyclical):
    ///        price <= refLow  -> bandHigh (PRANA cheap/abundant: fee high)
    ///        price >= refHigh -> bandLow  (PRANA scarce/valuable: fee low)
    ///        between          -> linear blend
    function _interpByPrice(
        uint256 price,
        uint256 refLow,
        uint256 refHigh,
        uint16 bandLow,
        uint16 bandHigh
    ) internal pure returns (uint16) {
        if (price <= refLow) return bandHigh;
        if (price >= refHigh) return bandLow;
        // frac = (price - refLow) / (refHigh - refLow), in [0,1]. rate = bandHigh - frac*(bandHigh-bandLow)
        uint256 span = refHigh - refLow;
        uint256 drop = (uint256(bandHigh - bandLow) * (price - refLow)) / span;
        return uint16(uint256(bandHigh) - drop);
    }

    /// @dev Validate param sanity and the floor/ceiling caps. All bands must sit inside the caps.
    function _validate(Params memory p) internal pure {
        if (p.floorBps == 0 || p.ceilingBps == 0 || p.ceilingBps > BPS_DENOM || p.floorBps > p.ceilingBps) {
            revert BadBounds();
        }
        // bands ordered and inside the caps
        if (
            p.steadyFloorBps > p.steadyCeilBps ||
            p.steadyCeilBps > p.bootstrapCeilBps ||
            p.steadyFloorBps < p.floorBps ||
            p.bootstrapCeilBps > p.ceilingBps
        ) {
            revert BadBand();
        }
        if (p.refLowPrice >= p.refHighPrice) revert BadPriceRefs();
    }
}
