// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MintSinkGuard — "every emission has a paired sink" registry
/// @notice Enforces the money-map invariant that no inflationary reward token (minted on proof,
///         e.g. by {ProofOfSolarOracleMint}) is wired up as mintable unless a matching deflationary
///         sink (a {BurnMine} / {UsageBurn} contract) is registered against it. The deploy flow
///         calls {assertSinkExists} before granting a mint-on-proof contract minter authority on a
///         reward token; if no sink is registered the assertion reverts and the wiring is refused.
/// @dev    This is a lightweight off-to-the-side registry; it does NOT itself hold mint authority.
///         An admin registers (rewardToken => sinkContract) pairs; the deploy script (and any
///         on-chain caller that wants the guarantee) gates on {assertSinkExists}.
contract MintSinkGuard is AccessControl {
    /// @notice May register / unregister reward-token => sink pairs.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice The sink contract registered for a reward token (address(0) = none).
    mapping(address => address) public sinkOf;

    /// @notice All reward tokens that have ever had a sink registered (for enumeration).
    address[] public registeredTokens;
    mapping(address => bool) private _known;

    event SinkRegistered(address indexed rewardToken, address indexed sink, address indexed by);
    event SinkUnregistered(address indexed rewardToken, address indexed previousSink, address indexed by);

    error ZeroRewardToken();
    error ZeroSink();
    error NoSinkRegistered(address rewardToken);
    error AlreadyRegistered(address rewardToken, address sink);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroRewardToken();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    /// @notice Register the deflationary sink that pairs with `rewardToken`. Idempotent updates are
    ///         allowed (re-pointing to a new sink), but re-registering the SAME pair reverts to make
    ///         accidental double-calls loud.
    function registerSink(address rewardToken, address sink) external onlyRole(REGISTRAR_ROLE) {
        if (rewardToken == address(0)) revert ZeroRewardToken();
        if (sink == address(0)) revert ZeroSink();
        if (sinkOf[rewardToken] == sink) revert AlreadyRegistered(rewardToken, sink);

        sinkOf[rewardToken] = sink;
        if (!_known[rewardToken]) {
            _known[rewardToken] = true;
            registeredTokens.push(rewardToken);
        }
        emit SinkRegistered(rewardToken, sink, msg.sender);
    }

    /// @notice Remove the sink pairing for `rewardToken` (e.g. retiring a sink). After this,
    ///         {assertSinkExists} for that token will revert again.
    function unregisterSink(address rewardToken) external onlyRole(REGISTRAR_ROLE) {
        address prev = sinkOf[rewardToken];
        if (prev == address(0)) revert NoSinkRegistered(rewardToken);
        delete sinkOf[rewardToken];
        emit SinkUnregistered(rewardToken, prev, msg.sender);
    }

    /// @notice Revert unless a sink is registered for `rewardToken`. The deploy flow calls this
    ///         before granting any mint-on-proof contract minter authority on the reward token.
    function assertSinkExists(address rewardToken) external view {
        if (sinkOf[rewardToken] == address(0)) revert NoSinkRegistered(rewardToken);
    }

    /// @notice View helper mirroring {assertSinkExists} without reverting.
    function hasSink(address rewardToken) external view returns (bool) {
        return sinkOf[rewardToken] != address(0);
    }

    /// @notice Number of reward tokens that have ever been registered (sink may be currently unset
    ///         if later unregistered; check {sinkOf}).
    function registeredTokenCount() external view returns (uint256) {
        return registeredTokens.length;
    }
}
