// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Permit2Lite} from "./Permit2Lite.sol";

/// @title DepositWithPermit2Example — signature-driven deposit into a demo vault.
/// @notice Shows the intended Permit2-style flow: a user signs ONE {Permit2Lite.PermitTransferFrom}
///         naming THIS contract as spender, then this contract pulls the tokens straight into its
///         own vault accounting in a single call — no separate ERC-20 approve to the vault.
/// @dev ⚠️ Built on the Permit2-SHAPED {Permit2Lite}, not canonical Permit2 (see that contract's
///      NatSpec). Production should integrate the official Permit2 deployment instead.
contract DepositWithPermit2Example {
    /// @notice The Permit2-shaped contract this example pulls through.
    Permit2Lite public immutable permit2;

    /// @notice Per-user deposited balance held by this demo vault.
    mapping(address => uint256) public deposits;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);

    error InsufficientDeposit(uint256 requested, uint256 available);

    constructor(Permit2Lite _permit2) {
        permit2 = _permit2;
    }

    /// @notice Deposit `amount` of `permit.token` by presenting the owner's Permit2-style signature.
    /// @dev The permit MUST name this contract as `spender` so the pull lands here; we then credit
    ///      the owner's vault balance. `owner` is the signer/depositor.
    /// @param permit The owner's signed transfer authorization (spender == address(this)).
    /// @param owner The depositor who signed `permit` and approved Permit2Lite.
    /// @param amount The amount to deposit (<= permit.amount).
    /// @param signature The owner's EIP-712 signature.
    function depositWithPermit(
        Permit2Lite.PermitTransferFrom calldata permit,
        address owner,
        uint256 amount,
        bytes calldata signature
    ) external {
        // Permit2Lite verifies the signature, deadline, and nonce, then transfers token -> spender.
        // Because permit.spender == address(this), the tokens arrive in this vault.
        permit2.permitTransferFrom(permit, owner, amount, signature);
        deposits[owner] += amount;
        emit Deposited(owner, permit.token, amount);
    }

    /// @notice Withdraw previously deposited `token` back to the caller.
    function withdraw(address token, uint256 amount) external {
        uint256 bal = deposits[msg.sender];
        if (amount > bal) revert InsufficientDeposit(amount, bal);
        deposits[msg.sender] = bal - amount;
        // Demo vault holds the tokens directly; return them to the depositor.
        require(IERC20(token).transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, token, amount);
    }
}
