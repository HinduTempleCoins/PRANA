// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SessionKeyGrant — scoped, capped, expiring authorizations (the signer-grant model on-chain)
/// @notice An account grants a session key permission to call ONE (target, selector) up to a spend
///         `cap`, until `expiry`, independently revocable. Mirrors the wallet-security "grant taxonomy":
///         a bot's cap is enforced HERE, not in the bot — a hijacked key hits the wall. This is the
///         authorization ledger; a trusted executor consults `check()` and records `consume()`.
contract SessionKeyGrant {
    struct Grant {
        address target;
        bytes4 selector;
        uint256 cap;
        uint256 spent;
        uint64 expiry;
        bool active;
    }

    // account => sessionKey => grant
    mapping(address => mapping(address => Grant)) public grants;

    event Granted(address indexed account, address indexed key, address target, bytes4 selector, uint256 cap, uint64 expiry);
    event Revoked(address indexed account, address indexed key);
    event Consumed(address indexed account, address indexed key, uint256 amount, uint256 spent);

    function grant(address key, address target, bytes4 selector, uint256 cap, uint64 expiry) external {
        require(key != address(0), "key=0");
        require(expiry > block.timestamp, "expired");
        grants[msg.sender][key] = Grant(target, selector, cap, 0, expiry, true);
        emit Granted(msg.sender, key, target, selector, cap, expiry);
    }

    function revoke(address key) external {
        grants[msg.sender][key].active = false;
        emit Revoked(msg.sender, key);
    }

    function check(address account, address key, address target, bytes4 selector, uint256 amount)
        public view returns (bool)
    {
        Grant storage g = grants[account][key];
        return g.active
            && block.timestamp < g.expiry
            && g.target == target
            && g.selector == selector
            && g.spent + amount <= g.cap;
    }

    /// @notice Record spend after an authorized action. Caller (the key or a trusted executor) must pass check().
    function consume(address account, address key, address target, bytes4 selector, uint256 amount) external {
        require(check(account, key, target, selector, amount), "not authorized");
        Grant storage g = grants[account][key];
        g.spent += amount;
        emit Consumed(account, key, amount, g.spent);
    }

    function remaining(address account, address key) external view returns (uint256) {
        Grant storage g = grants[account][key];
        if (!g.active || block.timestamp >= g.expiry || g.spent >= g.cap) return 0;
        return g.cap - g.spent;
    }
}
