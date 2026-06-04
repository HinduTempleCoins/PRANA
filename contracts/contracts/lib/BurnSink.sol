// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal view of {ERC20Burnable.burn}. Used to feature-detect a real burn path.
interface IERC20Burnable {
    function burn(uint256 amount) external;
}

/// @dev Minimal view of {ProofOfBurnRegistry} for optional receipt notification. NOTE: the real
///      registry's recordBurn() does a burnFrom() of the CALLER's tokens, so a BurnSinkBase only
///      uses this for self-recording semantics if it wants the registry to also burn from it — most
///      sinks just want to LOG, so BurnSinkBase records a local ledger and emits its own event,
///      and treats the registry as an optional best-effort notification (try/catch).
interface IProofOfBurnRegistryLike {
    function recordBurn(address token, uint256 amount, bytes32 ref) external returns (uint256 id);
}

/// @title BurnSink — the "eater"/burn-sink helper library
/// @notice safeBurn tries the real ERC20Burnable.burn (reduces totalSupply — a true supply sink);
///         if the token isn't burnable, it falls back to transferring to the canonical dead address
///         0x...dEaD.
/// @dev TRADE-OFF (read this): burn() permanently REDUCES totalSupply — the gold-standard sink, but
///      only works if the token exposes a public burn. Sending to 0x..dEaD does NOT reduce
///      totalSupply (the tokens still "exist", just at an address no one controls); it is the
///      universal fallback that works for ANY ERC-20. Prefer burn() when available.
library BurnSink {
    using SafeERC20 for IERC20;

    /// @notice The canonical "dead" black-hole address. Tokens here are unspendable but still count
    ///         toward totalSupply (unlike a real burn).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    error ZeroAmount();

    /// @notice Burn `amount` of `token` already held by the caller (this contract): try
    ///         ERC20Burnable.burn first, else transfer to the dead address.
    /// @return burned true if a real burn() reduced totalSupply; false if it fell back to dead-send.
    function safeBurn(IERC20 token, uint256 amount) internal returns (bool burned) {
        if (amount == 0) revert ZeroAmount();
        try IERC20Burnable(address(token)).burn(amount) {
            return true;
        } catch {
            token.safeTransfer(DEAD, amount);
            return false;
        }
    }

    /// @notice Pull `amount` of `token` from `from` (needs approval) then sink it via {safeBurn}.
    /// @dev Pulls into THIS contract first, so the subsequent burn()/dead-transfer operates on a
    ///      balance the contract actually holds.
    /// @return burned true if a real burn() reduced totalSupply; false if it fell back to dead-send.
    function sinkFrom(IERC20 token, address from, uint256 amount) internal returns (bool burned) {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(from, address(this), amount);
        return safeBurn(token, amount);
    }
}

/// @title BurnSinkBase — reusable base for contracts that act as a token eater
/// @notice Tracks cumulative burned per token, emits Sunk events, and (optionally) notifies a
///         {ProofOfBurnRegistry}-like contract when one is configured. Inheritors call the internal
///         `_sink` / `_sinkFrom` helpers.
abstract contract BurnSinkBase {
    using BurnSink for IERC20;

    /// @notice token => cumulative amount sunk through this contract (burned + dead-sent).
    mapping(address => uint256) public totalSunk;
    /// @notice Optional registry to notify on each sink (0 = disabled).
    IProofOfBurnRegistryLike public burnRegistry;

    /// @param token the sunk token.
    /// @param amount amount sunk.
    /// @param burned true = real burn (totalSupply reduced); false = sent to dead address.
    event Sunk(address indexed token, uint256 amount, bool burned);
    event BurnRegistrySet(address indexed registry);

    /// @dev Set/clear the optional burn registry. Inheritors gate this behind their own auth.
    function _setBurnRegistry(IProofOfBurnRegistryLike registry) internal {
        burnRegistry = registry;
        emit BurnRegistrySet(address(registry));
    }

    /// @dev Sink `amount` of `token` already held by this contract; account + notify.
    function _sink(IERC20 token, uint256 amount, bytes32 ref) internal returns (bool burned) {
        burned = token.safeBurn(amount);
        _afterSink(address(token), amount, burned, ref);
    }

    /// @dev Pull `amount` of `token` from `from` then sink it; account + notify.
    function _sinkFrom(IERC20 token, address from, uint256 amount, bytes32 ref)
        internal
        returns (bool burned)
    {
        burned = token.sinkFrom(from, amount);
        _afterSink(address(token), amount, burned, ref);
    }

    /// @dev Common bookkeeping + best-effort registry notification.
    function _afterSink(address token, uint256 amount, bool burned, bytes32 ref) private {
        totalSunk[token] += amount;
        emit Sunk(token, amount, burned);
        if (address(burnRegistry) != address(0)) {
            // Best-effort: a registry revert (e.g. it tries to burnFrom us without allowance) must
            // not undo a completed sink. We swallow failures so the eater stays robust.
            try burnRegistry.recordBurn(token, amount, ref) {} catch {}
        }
    }
}
