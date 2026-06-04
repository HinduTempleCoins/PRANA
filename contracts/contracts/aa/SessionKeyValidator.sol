// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SessionKeyValidator — scoped, capped, expiring session keys for a SmartAccount
/// @notice An optional module a SmartAccount consults during validateUserOp. The account's
///         owner registers a session key with a scope: it may call ONE (allowedTarget,
///         allowedSelector), with a per-op value cap and a total spend cap, valid only within
///         [validAfter, validUntil]. Mirrors the `SessionKeyGrant` semantics (target/selector/
///         cap/expiry, revocable) but is purpose-built for the AA validate/execute path: it
///         exposes a single `validateSession()` the account calls, and the account records
///         spend via `recordSpend()` on the execution path.
/// @dev    One validator can serve many accounts: every entry is keyed by (account, key), and
///         all state-changing calls are made BY the account (msg.sender == account). A hijacked
///         session key hits these caps — enforcement lives here, not in any off-chain bot.
contract SessionKeyValidator {
    struct Session {
        uint48 validAfter;
        uint48 validUntil;
        address allowedTarget;
        bytes4 allowedSelector;
        uint256 valueCap;   // max native value per single op
        uint256 spendCap;   // max cumulative native value over the session's life
        uint256 spent;      // cumulative native value spent so far
        bool active;
    }

    // account => sessionKey => session
    mapping(address => mapping(address => Session)) private _sessions;

    event SessionRegistered(
        address indexed account,
        address indexed key,
        address allowedTarget,
        bytes4 allowedSelector,
        uint48 validAfter,
        uint48 validUntil,
        uint256 valueCap,
        uint256 spendCap
    );
    event SessionRevoked(address indexed account, address indexed key);
    event SessionSpent(address indexed account, address indexed key, uint256 amount, uint256 spent);

    error ZeroKey();
    error BadTimeRange();
    error NotRegistered();
    error OutOfScope();
    error ValueCapExceeded();
    error SpendCapExceeded();

    /// @notice Owner-account registers/overwrites a session key's scope.
    /// @dev    Called BY the account (msg.sender == account); the SmartAccount gates this to
    ///         its owner. Re-registering an existing key resets its `spent` to zero.
    function registerSession(
        address key,
        address allowedTarget,
        bytes4 allowedSelector,
        uint48 validAfter,
        uint48 validUntil,
        uint256 valueCap,
        uint256 spendCap
    ) external {
        if (key == address(0)) revert ZeroKey();
        // validUntil == 0 would mean "no expiry"; require a real upper bound for sessions.
        if (validUntil == 0 || validUntil <= validAfter) revert BadTimeRange();

        _sessions[msg.sender][key] = Session({
            validAfter: validAfter,
            validUntil: validUntil,
            allowedTarget: allowedTarget,
            allowedSelector: allowedSelector,
            valueCap: valueCap,
            spendCap: spendCap,
            spent: 0,
            active: true
        });

        emit SessionRegistered(
            msg.sender, key, allowedTarget, allowedSelector, validAfter, validUntil, valueCap, spendCap
        );
    }

    /// @notice Owner-account revokes a session key.
    function revokeSession(address key) external {
        _sessions[msg.sender][key].active = false;
        emit SessionRevoked(msg.sender, key);
    }

    /// @notice Read a session's scope/state.
    function sessionOf(address account, address key) external view returns (Session memory) {
        return _sessions[account][key];
    }

    /// @notice Validate that `key` may perform (target, selector, value) for `account`, and
    ///         return the session's time range packed for v0.7 `validationData`.
    /// @dev    View-only scope check (no spend mutation). Reverts on any out-of-scope condition
    ///         so the account can distinguish a scope failure from a plain bad signature. The
    ///         caller (the SmartAccount) packs the returned (validAfter, validUntil) into
    ///         validationData so the EntryPoint enforces the time range.
    function validateSession(
        address account,
        address key,
        address target,
        bytes4 selector,
        uint256 value
    ) external view returns (uint48 validAfter, uint48 validUntil) {
        Session storage s = _sessions[account][key];
        if (!s.active) revert NotRegistered();
        if (s.allowedTarget != target || s.allowedSelector != selector) revert OutOfScope();
        if (value > s.valueCap) revert ValueCapExceeded();
        if (s.spent + value > s.spendCap) revert SpendCapExceeded();
        return (s.validAfter, s.validUntil);
    }

    /// @notice Record native spend after an authorized op executes.
    /// @dev    Called BY the account (msg.sender == account) on the execution path. Re-checks
    ///         the cap so spend can never exceed `spendCap` even across concurrent ops.
    function recordSpend(address key, uint256 amount) external {
        Session storage s = _sessions[msg.sender][key];
        if (!s.active) revert NotRegistered();
        if (s.spent + amount > s.spendCap) revert SpendCapExceeded();
        s.spent += amount;
        emit SessionSpent(msg.sender, key, amount, s.spent);
    }

    /// @notice Remaining total spend allowance for (account, key); 0 if inactive/expired/used up.
    function remaining(address account, address key) external view returns (uint256) {
        Session storage s = _sessions[account][key];
        if (!s.active || block.timestamp > s.validUntil || s.spent >= s.spendCap) return 0;
        return s.spendCap - s.spent;
    }
}
