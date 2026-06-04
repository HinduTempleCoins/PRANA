// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title VeBoost — Curve-style boost math for ve-weighted liquidity gauges
/// @notice Pure library implementing the canonical Curve "working balance" boost. A gauge that
///         streams rewards by stake×time can multiply a depositor's *effective* stake by up to
///         2.5x when that depositor also holds vote-escrow (ve) weight, while never dropping below
///         a 1x floor. This rewards liquidity that is *also* governance-aligned, without letting a
///         large ve holder farm more than their actual deposit.
/// @dev The formula (all values 1e18-token-native, i.e. plain integer token units — NOT an extra
///      1e18 fixed-point scaling on top):
///
///        workingBalance = min( 0.4 * deposit
///                              + 0.6 * totalDeposits * userVe / totalVe,
///                              deposit )
///
///      - The `0.4 * deposit` term is the unconditional floor: even with zero ve you keep 40% of
///        your deposit as working balance (a flat 1x baseline once everyone is unboosted, because
///        the gauge divides by the *sum* of working balances).
///      - The `0.6 * totalDeposits * userVe/totalVe` term adds boost proportional to your *share*
///        of total ve relative to your *share* of total deposits.
///      - The outer `min(..., deposit)` caps working balance at the raw deposit, which is exactly
///        the 2.5x cap (deposit / (0.4*deposit) = 2.5).
///
///      Rounding: every term rounds DOWN (Solidity integer division). The min() guarantees we never
///      over-credit, so any rounding error can only ever slightly UNDER-credit working balance —
///      the conservative direction for a reward accountant (it can never mint value from nothing).
library VeBoost {
    /// @dev 1e18 fixed-point one, used only for the boostMultiplier return (a ratio, not a balance).
    uint256 internal constant WAD = 1e18;

    /// @dev Numerator/denominator for the 0.4 floor coefficient (40%).
    uint256 private constant FLOOR_NUM = 40;
    /// @dev Numerator for the 0.6 boost coefficient (60%).
    uint256 private constant BOOST_NUM = 60;
    /// @dev Common denominator (100%) for the 0.4 / 0.6 split.
    uint256 private constant DEN = 100;

    /// @notice Compute a depositor's Curve working balance.
    /// @param deposit       The user's raw deposited stake (token units).
    /// @param totalDeposits The sum of all raw deposits in the gauge (token units).
    /// @param userVe        The user's current ve voting weight.
    /// @param totalVe       The total ve voting weight across all users.
    /// @return workingBalance The boosted effective stake, in [0.4*deposit, deposit].
    /// @dev Handles edge cases:
    ///      - deposit == 0          → 0 (no stake, no working balance).
    ///      - totalVe == 0          → no boost term → floor of 0.4*deposit (everyone unboosted).
    ///      - userVe == 0           → floor of 0.4*deposit.
    ///      - userVe/totalVe large  → min() clamps to `deposit` (the 2.5x cap).
    function computeWorkingBalance(
        uint256 deposit,
        uint256 totalDeposits,
        uint256 userVe,
        uint256 totalVe
    ) internal pure returns (uint256 workingBalance) {
        if (deposit == 0) return 0;

        // Unconditional floor: 40% of the deposit.
        uint256 lim = (deposit * FLOOR_NUM) / DEN;

        // Boost term only applies when there is ve in the system and the user holds some.
        if (totalVe > 0 && userVe > 0) {
            // 0.6 * totalDeposits * (userVe / totalVe).
            // Multiply before dividing to preserve precision; intermediate fits well under 2^256
            // for any realistic token supply (each factor << 1e40).
            uint256 boost = (totalDeposits * userVe * BOOST_NUM) / (totalVe * DEN);
            lim += boost;
        }

        // Cap at the raw deposit (the 2.5x ceiling). min(lim, deposit).
        workingBalance = lim < deposit ? lim : deposit;
    }

    /// @notice The boost multiplier a deposit is currently receiving, as a 1e18 fixed-point ratio.
    /// @param deposit       The user's raw deposited stake (token units).
    /// @param totalDeposits The sum of all raw deposits in the gauge (token units).
    /// @param userVe        The user's current ve voting weight.
    /// @param totalVe       The total ve voting weight across all users.
    /// @return multiplier   workingBalance / (0.4 * deposit), scaled by 1e18, bounded to [1e18, 2.5e18].
    /// @dev This is purely informational (UI / analytics): the gauge itself accounts in working
    ///      balances, not multipliers. By construction the unboosted floor maps to exactly 1x and
    ///      the deposit cap to exactly 2.5x, but we still clamp the returned value to [1e18, 2.5e18]
    ///      to absorb integer-division rounding at the boundaries.
    function boostMultiplier(
        uint256 deposit,
        uint256 totalDeposits,
        uint256 userVe,
        uint256 totalVe
    ) internal pure returns (uint256 multiplier) {
        if (deposit == 0) return WAD; // no deposit → conventionally the 1x baseline.

        uint256 wb = computeWorkingBalance(deposit, totalDeposits, userVe, totalVe);
        uint256 floor = (deposit * FLOOR_NUM) / DEN; // 0.4 * deposit

        if (floor == 0) {
            // deposit so tiny that 0.4*deposit rounds to 0; treat as the 1x baseline.
            return WAD;
        }

        // multiplier = wb / floor, in 1e18 fixed point.
        multiplier = (wb * WAD) / floor;

        // Clamp to [1x, 2.5x] to absorb rounding at the boundaries.
        if (multiplier < WAD) {
            multiplier = WAD;
        } else if (multiplier > (WAD * 5) / 2) {
            multiplier = (WAD * 5) / 2;
        }
    }
}
