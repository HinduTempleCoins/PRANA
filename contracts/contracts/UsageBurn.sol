// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title UsageBurn — burn-to-use (Factom model)
/// @notice Burn a token to record a unit of service usage tied to an off-chain reference
///         (e.g. a content id). This is the EXOGENOUS utility sink: the token is consumed to
///         *use the service*, which makes the burn economy real instead of circular.
///         Caller must approve this contract to spend `amount` (we use burnFrom).
contract UsageBurn {
    ERC20Burnable public immutable token;

    mapping(address => uint256) public burnedBy; // total burned by a user
    uint256 public totalBurned;

    event Used(address indexed user, uint256 amount, bytes32 indexed ref);

    constructor(ERC20Burnable token_) {
        require(address(token_) != address(0), "token=0");
        token = token_;
    }

    /// @notice Burn `amount` of the token to record usage against `ref`.
    function use(uint256 amount, bytes32 ref) external {
        require(amount > 0, "amount=0");
        token.burnFrom(msg.sender, amount);
        unchecked {
            burnedBy[msg.sender] += amount;
            totalBurned += amount;
        }
        emit Used(msg.sender, amount, ref);
    }
}
