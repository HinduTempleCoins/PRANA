// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBurnStakePriceSource — normalizes a burned amount of any currency into PRANA-weight.
///
/// @notice The {MultiCurrencyBurnRouter} accepts PRANA *and* wrapped ecosystem ERC-20s
///         (wMELEK/wVKBT/CURE/SMTs). Burning $X of any of them should credit the SAME amount of
///         permanent BurnStakeRegistry weight as burning $X of PRANA. A price source encapsulates
///         that "value → PRANA-weight" conversion so the router stays currency-agnostic.
///
/// @dev    `weightOf(token, amount)` returns the weight (in PRANA-weight units, conventionally 1e18-
///         scaled like native PRANA wei) to credit for burning `amount` of `token`. Implementations:
///           - {FixedRatioPriceSource}: admin sets a per-token ratio (safe default — no oracle dep).
///           - {OracleBurnStakePriceSource}: reads a price oracle to value the burn live.
///         Which source backs which currency is a USER/DAO decision; default to fixed-ratio.
interface IBurnStakePriceSource {
    /// @notice PRANA-weight credited for burning `amount` of `token`. MUST revert if `token` is not
    ///         priced/supported (so the router fails closed rather than crediting zero weight).
    function weightOf(address token, uint256 amount) external view returns (uint256 weight);
}
