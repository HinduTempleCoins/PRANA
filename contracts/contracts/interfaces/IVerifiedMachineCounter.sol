// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IVerifiedMachineCounter — read surface for the sustained verified-machine count.
/// @notice The countercyclical fee curve needs ONE honest number: how many verified,
///         work-contributing machines have been continuously active over a trailing window.
///         A momentary spike must NOT move the number (Sybil defense), so consumers read the
///         windowed-sustained value, never a raw instantaneous count.
interface IVerifiedMachineCounter {
    /// @notice Count of verified machines that have been active across the WHOLE trailing
    ///         window (i.e. seen in every sub-bucket of the window). This is the Sybil-resistant
    ///         figure the fee oracle reads for its threshold-X comparison.
    function sustainedCount() external view returns (uint256);
}
