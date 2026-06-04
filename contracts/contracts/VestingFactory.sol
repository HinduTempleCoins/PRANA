// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TokenVesting} from "./TokenVesting.sol";

/// @title VestingFactory — deploys and funds TokenVesting instances
/// @notice Pulls `total` tokens from the caller, deploys a fresh TokenVesting, funds it with
///         `total`, and records it (global list + per-beneficiary list). The caller must approve
///         this factory for at least `total` before calling. Transparent and immutable — fits the
///         no-premine posture; publish the factory address and inspect the children on-chain.
contract VestingFactory {
    using SafeERC20 for IERC20;

    /// @notice Every vesting contract this factory has created, in order.
    TokenVesting[] public allVestings;

    /// @notice Vesting contracts created for each beneficiary.
    mapping(address => TokenVesting[]) public vestingsOf;

    event VestingCreated(
        address indexed vesting,
        address indexed beneficiary,
        address indexed token,
        uint256 total
    );

    /// @notice Deploy and fund a TokenVesting for `beneficiary`.
    /// @dev Pulls `total` from msg.sender (requires prior approval), deploys the child, and
    ///      forwards the full `total` into it.
    /// @return vesting The address of the newly deployed TokenVesting.
    function createVesting(
        IERC20 token,
        address beneficiary,
        uint64 start,
        uint64 cliffSeconds,
        uint64 duration,
        uint256 total
    ) external returns (TokenVesting vesting) {
        // Pull the funding tokens in first so the factory holds them before deploying the child.
        token.safeTransferFrom(msg.sender, address(this), total);

        vesting = new TokenVesting(token, beneficiary, start, cliffSeconds, duration, total);

        token.safeTransfer(address(vesting), total);

        allVestings.push(vesting);
        vestingsOf[beneficiary].push(vesting);

        emit VestingCreated(address(vesting), beneficiary, address(token), total);
    }

    /// @notice Total number of vesting contracts created.
    function allVestingsLength() external view returns (uint256) {
        return allVestings.length;
    }

    /// @notice Number of vesting contracts created for `beneficiary`.
    function vestingsOfLength(address beneficiary) external view returns (uint256) {
        return vestingsOf[beneficiary].length;
    }
}
