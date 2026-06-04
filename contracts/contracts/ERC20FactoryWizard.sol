// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Base} from "./ERC20Base.sol";

/// @title ERC20FactoryWizard — the deploy-wizard core: one call → a live, owned ERC-20
/// @notice Deploys an `ERC20Base` (capped/pausable/permit/burnable), optionally mints an initial
///         supply, then hands ALL roles to the creator and renounces the factory's own roles — so
///         the factory is never a backdoor. Emits a registry event an explorer can index/verify.
contract ERC20FactoryWizard {
    address[] public allTokens;
    mapping(address => address) public creatorOf;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 cap);

    function createToken(
        string calldata name,
        string calldata symbol,
        uint256 cap,
        uint256 initialMint,
        address mintTo
    ) external returns (address token) {
        // factory is the initial admin so it can mint + then hand over roles
        ERC20Base t = new ERC20Base(name, symbol, cap, address(this));

        if (initialMint > 0) {
            require(mintTo != address(0), "mintTo=0");
            t.mint(mintTo, initialMint);
        }

        bytes32 ADMIN = t.DEFAULT_ADMIN_ROLE();
        bytes32 MINTER = t.MINTER_ROLE();
        bytes32 PAUSER = t.PAUSER_ROLE();

        // grant everything to the creator, then drop the factory's own authority
        t.grantRole(ADMIN, msg.sender);
        t.grantRole(MINTER, msg.sender);
        t.grantRole(PAUSER, msg.sender);
        t.renounceRole(MINTER, address(this));
        t.renounceRole(PAUSER, address(this));
        t.renounceRole(ADMIN, address(this));

        token = address(t);
        allTokens.push(token);
        creatorOf[token] = msg.sender;
        emit TokenCreated(token, msg.sender, name, symbol, cap);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
