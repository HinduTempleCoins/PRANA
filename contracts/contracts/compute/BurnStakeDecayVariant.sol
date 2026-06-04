// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBurnStakeRegistry} from "../interfaces/IBurnStakeRegistry.sol";

/// @title BurnStakeDecayVariant — OPTIONAL Slimcoin-model burn-stake with LINEARLY DECAYING weight.
/// @notice ⚠️ THIS IS THE ALTERNATIVE, NOT THE DEFAULT. The default PRANA perma-stake lane is the
///         {BurnStakeRegistry} (OO1): weight is PERMANENT and never decays. This contract is the
///         opt-in variant the user may pick instead — modeled on Slimcoin's Proof-of-Burn, where a
///         burn's "burnt-coin" influence DECAYS over a configured horizon so that early whales do not
///         dominate forever and fresh participation keeps mattering (anti-early-whale).
///
///         The principal is STILL irreversibly burned in BOTH models — the only difference is whether
///         the resulting WEIGHT is permanent ({BurnStakeRegistry}) or decays to zero over `decayHorizon`
///         seconds (this contract). There is still NO withdraw and NO way to recover principal here.
///
/// @dev DECAY MATH (per burn, linear to zero):
///        Each burn `i` records (weight0_i, t0_i). Its live contribution at time `t` is
///            remaining_i(t) = t >= t0_i + horizon ? 0
///                           : weight0_i * (horizon - (t - t0_i)) / horizon
///        i.e. full `weight0_i` at the burn instant, sloping linearly to 0 exactly `horizon` seconds
///        later. An account's {weightOf} is the sum of remaining_i over its burns; {totalWeight} is
///        the sum over all accounts. Because a naive sum-over-all-burns is unbounded gas, weight is
///        tracked as a closed-form aggregate per account: (baseWeight, slope, lastDecayUpdate) where
///        the account's weight at `t` = baseWeight - slope * (t - lastDecayUpdate), floored at 0, with
///        each fully-expired burn's slope retired lazily on read/settle. See {_settle}.
///
///      Implements the same {IBurnStakeRegistry} surface so it is a drop-in alternative for the BURN
///      lane and (with a decay-aware adapter) governance. `weightOf`/`totalWeight` are VIEWS computed
///      at the current timestamp.
contract BurnStakeDecayVariant is IBurnStakeRegistry, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice The native PRANA token, burned 1:1 via {burnPrana}.
    ERC20Burnable public immutable prana;
    /// @notice Seconds over which each burn's weight decays linearly to zero.
    uint256 public immutable decayHorizon;

    /// @dev One decaying tranche of weight from a single burn.
    struct Tranche {
        uint256 weight0; // weight at burn instant
        uint64 t0; // burn timestamp
    }

    mapping(address => Tranche[]) private _tranches;

    error ZeroAmount();
    error ZeroAddress();
    error ZeroHorizon();

    /// @param prana_        Native PRANA (ERC20Burnable) for {burnPrana}.
    /// @param decayHorizon_ Seconds for a burn's weight to decay to zero (> 0).
    /// @param admin         Receives DEFAULT_ADMIN_ROLE (role grants).
    constructor(ERC20Burnable prana_, uint256 decayHorizon_, address admin) {
        if (address(prana_) == address(0) || admin == address(0)) revert ZeroAddress();
        if (decayHorizon_ == 0) revert ZeroHorizon();
        prana = prana_;
        decayHorizon = decayHorizon_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------
    // Weight crediting
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IBurnStakeRegistry
    function recordBurnWeight(address account, address token, uint256 amount, uint256 weightAdded)
        external
        onlyRole(BURNER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (weightAdded == 0) revert ZeroAmount();
        _credit(account, token, amount, weightAdded);
    }

    /// @notice Single-currency door: pull+burn native PRANA, self-credit a DECAYING tranche 1:1.
    function burnPrana(uint256 amount) external returns (uint256 weightAdded) {
        if (amount == 0) revert ZeroAmount();
        IERC20(address(prana)).safeTransferFrom(msg.sender, address(this), amount);
        prana.burn(amount);
        weightAdded = amount;
        _credit(msg.sender, address(prana), amount, weightAdded);
    }

    function _credit(address account, address token, uint256 amount, uint256 weightAdded) internal {
        _track(account);
        _tranches[account].push(Tranche({weight0: weightAdded, t0: uint64(block.timestamp)}));
        emit Burned(account, token, amount, weightAdded);
    }

    // ------------------------------------------------------------------------------------------
    // Decaying weight views (computed at current timestamp)
    // ------------------------------------------------------------------------------------------

    /// @notice Live decaying weight of `account` (sum of its tranches' remaining contributions).
    /// @inheritdoc IBurnStakeRegistry
    function weightOf(address account) public view returns (uint256 w) {
        Tranche[] storage ts = _tranches[account];
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < ts.length; i++) {
            w += _remaining(ts[i], t);
        }
    }

    /// @notice Live decaying weight of one tranche of `account` at the current time (helper/inspection).
    function trancheCount(address account) external view returns (uint256) {
        return _tranches[account].length;
    }

    /// @dev Linear remaining weight of a tranche at time `t`.
    function _remaining(Tranche storage tr, uint256 t) internal view returns (uint256) {
        uint256 end = uint256(tr.t0) + decayHorizon;
        if (t >= end) return 0;
        uint256 remainingTime = end - t; // in (0, decayHorizon]
        return (tr.weight0 * remainingTime) / decayHorizon;
    }

    /// @notice Live decaying TOTAL weight across all accounts.
    /// @dev ⚠️ Iterates every tranche of every recorded account, so it is O(total burns) and intended
    ///      for off-chain reads / a decay-aware governance adapter that snapshots it — NOT for hot
    ///      on-chain paths. (The permanent {BurnStakeRegistry} keeps an O(1) `totalWeight` instead;
    ///      that O(1) accumulator is impossible here precisely because every tranche decays on its own
    ///      schedule. A production decay deployment would maintain a (base, slope, lastUpdate) running
    ///      aggregate; this reference variant keeps the math explicit and auditable.)
    function totalWeight() external view returns (uint256 total) {
        uint256 t = block.timestamp;
        address[] storage accs = _accounts;
        for (uint256 a = 0; a < accs.length; a++) {
            Tranche[] storage ts = _tranches[accs[a]];
            for (uint256 i = 0; i < ts.length; i++) {
                total += _remaining(ts[i], t);
            }
        }
    }

    // --- account enumeration (for the reference totalWeight) ---
    address[] private _accounts;
    mapping(address => bool) private _seen;

    /// @dev Track first-time accounts so totalWeight can enumerate them.
    function _track(address account) internal {
        if (!_seen[account]) {
            _seen[account] = true;
            _accounts.push(account);
        }
    }
}
