// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title UtilityToken
/// @notice A generic fee/utility ERC-20 consumed to pay for on-chain services.
///         Holders can burn their own tokens; an authorized fee-collector contract
///         (SPENDER_ROLE) can consume tokens a user has explicitly approved.
contract UtilityToken is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant SPENDER_ROLE = keccak256("SPENDER_ROLE");

    /// @notice Per-user allowance granted to a specific spender contract.
    ///         spenderAllowance[user][spender] = amount the spender may consume.
    mapping(address => mapping(address => uint256)) public spenderAllowance;

    event SpenderApproved(address indexed user, address indexed spender, uint256 amount);
    event Consumed(address indexed spender, address indexed from, uint256 amount);

    /// @param name_   ERC-20 token name.
    /// @param symbol_ ERC-20 token symbol.
    /// @param admin   Address granted DEFAULT_ADMIN_ROLE (manages all roles).
    constructor(string memory name_, string memory symbol_, address admin)
        ERC20(name_, symbol_)
    {
        require(admin != address(0), "UtilityToken: admin is zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Mint new tokens. Restricted to MINTER_ROLE.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Approve a spender contract to consume up to `amount` of the caller's tokens.
    ///         Setting amount to 0 revokes the approval.
    function approveSpender(address spender, uint256 amount) external {
        require(spender != address(0), "UtilityToken: spender is zero");
        spenderAllowance[msg.sender][spender] = amount;
        emit SpenderApproved(msg.sender, spender, amount);
    }

    /// @notice Consume (burn) `amount` of `from`'s tokens to pay for a service.
    ///         Callable only by a SPENDER_ROLE contract. The caller must either be
    ///         `from` itself or have been approved by `from` via approveSpender.
    function consume(address from, uint256 amount) external onlyRole(SPENDER_ROLE) {
        if (msg.sender != from) {
            uint256 allowed = spenderAllowance[from][msg.sender];
            require(allowed >= amount, "UtilityToken: spend amount exceeds approval");
            spenderAllowance[from][msg.sender] = allowed - amount;
        }
        _burn(from, amount);
        emit Consumed(msg.sender, from, amount);
    }
}
