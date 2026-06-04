// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHathorFeeController} from "../interfaces/IHathorFeeController.sol";

/// @title HathorFeeTreasury (PP3) — the protocol-fee sink that NEVER trades.
/// @notice Destination for the Hathor settlement skim. It is a passive COLLECTION vault: value
///         flows IN from {SettlementFeeHook} (and any other protocol fee route), and flows OUT
///         only by an explicit governance withdrawal.
///
///         BOUNDARY (institutional invariant, enforced by shape + role):
///           - The treasury NEVER trades. It holds no swap/AMM/router logic, has no approve/swap
///             surface, and exposes no path to move funds except `withdraw*`, which is gated to
///             GOVERNOR_ROLE. The intended GOVERNOR_ROLE holder is the DAO timelock (compose with
///             {TimelockVault} / DAOTimelock), so every outflow is time-locked and on-chain.
///           - Its purpose is to fund the institution and Hathor's own compute via governed
///             disbursement — not market activity. Hathor herself is read-only (she sets nothing
///             here); she cannot move these funds. Only governance can.
///
/// @dev Accepts native value (receive) and ERC-20 (pull-free: hooks just transfer in). Withdrawals
///      are explicit-amount and event-logged for auditability. No fallback that could be tricked
///      into spending; no token approvals are ever granted.
contract HathorFeeTreasury is AccessControl, IHathorFeeController {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to withdraw. Intended holder: the DAO timelock. NOT Hathor.
    bytes32 public constant override GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    event Received(address indexed from, uint256 amount);
    event WithdrawnERC20(address indexed token, address indexed to, uint256 amount);
    event WithdrawnNative(address indexed to, uint256 amount);

    error ZeroRecipient();
    error NativeSendFailed();

    /// @param admin    Receives DEFAULT_ADMIN_ROLE (role management). Set to the DAO/timelock.
    /// @param governor Receives GOVERNOR_ROLE (the withdrawal key). Set to the DAO timelock.
    constructor(address admin, address governor) {
        require(admin != address(0) && governor != address(0), "zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, governor);
    }

    /// @notice Accept native protocol fees. Pure collection — no logic runs on receipt.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Current ERC-20 balance held for `token` (what governance could disburse).
    function balanceERC20(IERC20 token) external view override returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Governance-only: disburse `amount` of `token` to `to`. The ONLY ERC-20 outflow path.
    function withdrawERC20(IERC20 token, address to, uint256 amount) external override onlyRole(GOVERNOR_ROLE) {
        if (to == address(0)) revert ZeroRecipient();
        token.safeTransfer(to, amount);
        emit WithdrawnERC20(address(token), to, amount);
    }

    /// @notice Governance-only: disburse `amount` of native value to `to`. The ONLY native outflow.
    function withdrawNative(address payable to, uint256 amount) external override onlyRole(GOVERNOR_ROLE) {
        if (to == address(0)) revert ZeroRecipient();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeSendFailed();
        emit WithdrawnNative(to, amount);
    }
}
