// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title BatchAirdrop
/// @notice Stateless push distributor: pulls the total owed from the caller and
///         forwards it to many recipients in a single transaction. Holds no balance
///         and keeps no state between calls.
contract BatchAirdrop {
    using SafeERC20 for IERC20;

    /// @notice Emitted once per successful airdrop with a summary of the batch.
    event Airdropped(
        address indexed token,
        address indexed sender,
        uint256 recipientCount,
        uint256 totalAmount
    );

    error EmptyRecipients();
    error LengthMismatch();

    /// @notice Distribute per-recipient `amounts` of `token` to `recipients`.
    /// @dev Caller must have approved this contract for the sum of `amounts`.
    ///      Funds are pulled in via transferFrom, then pushed out individually.
    /// @param token       The ERC-20 token to distribute.
    /// @param recipients  The addresses to receive tokens.
    /// @param amounts     The amount each corresponding recipient receives.
    function airdrop(
        IERC20 token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        uint256 len = recipients.length;
        if (len == 0) revert EmptyRecipients();
        if (len != amounts.length) revert LengthMismatch();

        uint256 total;
        for (uint256 i; i < len; ++i) {
            total += amounts[i];
        }

        token.safeTransferFrom(msg.sender, address(this), total);
        for (uint256 i; i < len; ++i) {
            token.safeTransfer(recipients[i], amounts[i]);
        }

        emit Airdropped(address(token), msg.sender, len, total);
    }

    /// @notice Distribute the same `amountEach` of `token` to every recipient.
    /// @param token       The ERC-20 token to distribute.
    /// @param recipients  The addresses to receive tokens.
    /// @param amountEach  The amount every recipient receives.
    function airdropEqual(
        IERC20 token,
        address[] calldata recipients,
        uint256 amountEach
    ) external {
        uint256 len = recipients.length;
        if (len == 0) revert EmptyRecipients();

        uint256 total = amountEach * len;
        token.safeTransferFrom(msg.sender, address(this), total);
        for (uint256 i; i < len; ++i) {
            token.safeTransfer(recipients[i], amountEach);
        }

        emit Airdropped(address(token), msg.sender, len, total);
    }
}
