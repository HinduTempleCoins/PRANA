// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBurnStakePriceSource} from "../interfaces/IBurnStakePriceSource.sol";
import {SimplePriceOracle} from "../SimplePriceOracle.sol";

/// @dev `WAD` = 1e18, the fixed-point scale used throughout (matches PRANA wei / token decimals).
uint256 constant WAD = 1e18;

/// @title FixedRatioPriceSource — admin-set per-token ratio of burned amount → PRANA-weight.
///
/// @notice The SAFE DEFAULT price source: no oracle dependency, no manipulation surface. An admin
///         sets `ratioWad[token]`, the 1e18-scaled PRANA-weight credited per 1 whole unit of the
///         burned token. weight = amount * ratioWad / 1e18.
///
///         Examples (ratioWad is "PRANA-weight per token", 1e18 = parity):
///           - PRANA itself:        ratioWad = 1e18  → 1 PRANA burned = 1 weight.
///           - wMELEK worth 0.5 PRANA: ratioWad = 0.5e18 → 1 wMELEK burned = 0.5 weight.
///           - CURE worth 2 PRANA:  ratioWad = 2e18  → 1 CURE burned = 2 weight.
///
/// @dev    Tokens with non-18 decimals: bake the decimal adjustment into `ratioWad` (the math is
///         purely amount*ratio/1e18 on raw base units). The DAO re-points ratios as market prices
///         drift; between updates the ratio is fixed (hence "fixed-ratio").
contract FixedRatioPriceSource is IBurnStakePriceSource, AccessControl {
    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

    /// @notice 1e18-scaled PRANA-weight per 1 base unit of the token (0 == unsupported).
    mapping(address => uint256) public ratioWad;

    event RatioSet(address indexed token, uint256 ratioWad);

    error TokenNotPriced(address token);
    error ZeroRatio();

    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTER_ROLE, admin);
    }

    /// @notice Set (or clear, with 0) the PRANA-weight-per-base-unit ratio for `token`.
    function setRatio(address token, uint256 ratioWad_) external onlyRole(SETTER_ROLE) {
        ratioWad[token] = ratioWad_;
        emit RatioSet(token, ratioWad_);
    }

    /// @inheritdoc IBurnStakePriceSource
    function weightOf(address token, uint256 amount) external view returns (uint256 weight) {
        uint256 r = ratioWad[token];
        if (r == 0) revert TokenNotPriced(token); // fail closed
        weight = (amount * r) / WAD;
    }
}

/// @title OracleBurnStakePriceSource — values a burn live via {SimplePriceOracle} prices.
///
/// @notice Reads each token's price from a {SimplePriceOracle} (which, in prod, is fed by a
///         {TWAPOracle}/Chainlink adapter — same `price` surface). weight = the burned token's value
///         in the common quote unit, expressed in PRANA-weight by dividing out PRANA's own price:
///
///             weight = amount * priceOf(token) / priceOf(PRANA)
///
///         i.e. "$X of any token ≈ $X of PRANA weight". If PRANA's oracle price is itself 1e18
///         (PRANA == the quote unit), this collapses to `amount * priceOf(token) / 1e18`.
///
/// @dev    ⚠️ ORACLE TRUST: weight tracks a price feed and is only as honest as that feed. Because
///         BurnStakeRegistry weight is PERMANENT and non-withdrawable, a manipulated price mints
///         permanent weight — prefer a manipulation-resistant TWAP source and prefer
///         {FixedRatioPriceSource} where a live feed is not warranted. Which source backs which
///         currency is a user/DAO decision.
contract OracleBurnStakePriceSource is IBurnStakePriceSource, AccessControl {
    /// @notice The oracle supplying 1e18-scaled prices in a common quote unit.
    SimplePriceOracle public immutable oracle;

    /// @notice The PRANA reference token whose oracle price denominates "PRANA-weight".
    address public immutable pranaRef;

    error TokenNotPriced(address token);
    error PranaNotPriced();

    /// @param admin    DEFAULT_ADMIN_ROLE (reserved for future config; weights are read-only here).
    /// @param oracle_  The price oracle to read.
    /// @param pranaRef_ The token address whose oracle price is the PRANA denominator (e.g. WPRANA).
    constructor(address admin, SimplePriceOracle oracle_, address pranaRef_) {
        require(admin != address(0), "admin=0");
        require(address(oracle_) != address(0) && pranaRef_ != address(0), "zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        oracle = oracle_;
        pranaRef = pranaRef_;
    }

    /// @inheritdoc IBurnStakePriceSource
    function weightOf(address token, uint256 amount) external view returns (uint256 weight) {
        uint256 pToken = oracle.price(token);
        if (pToken == 0) revert TokenNotPriced(token); // fail closed
        uint256 pPrana = oracle.price(pranaRef);
        if (pPrana == 0) revert PranaNotPriced();
        // value-in-quote = amount * pToken / 1e18; PRANA-weight = value / pPrana * 1e18.
        // Combine without intermediate scaling loss: amount * pToken / pPrana.
        weight = (amount * pToken) / pPrana;
    }
}
