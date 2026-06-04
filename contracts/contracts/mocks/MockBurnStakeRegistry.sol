// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IBurnStakeRegistry} from "../interfaces/IBurnStakeRegistry.sol";

/// @notice Test-only {IBurnStakeRegistry}: records weight and the last call's args so tests can
///         assert the router normalized + forwarded correctly. A sibling builds the real registry.
contract MockBurnStakeRegistry is IBurnStakeRegistry {
    mapping(address => uint256) public weight;
    uint256 public total;

    // Last-call capture for assertions.
    address public lastAccount;
    address public lastToken;
    uint256 public lastAmount;
    uint256 public lastWeightAdded;
    uint256 public calls;

    function weightOf(address account) external view returns (uint256) {
        return weight[account];
    }

    function totalWeight() external view returns (uint256) {
        return total;
    }

    function recordBurnWeight(address account, address token, uint256 amount, uint256 weightAdded)
        external
    {
        weight[account] += weightAdded;
        total += weightAdded;
        lastAccount = account;
        lastToken = token;
        lastAmount = amount;
        lastWeightAdded = weightAdded;
        calls += 1;
        emit Burned(account, token, amount, weightAdded);
    }
}
