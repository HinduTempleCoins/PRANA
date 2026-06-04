// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SimplePriceOracle — a role-fed price source (stand-in for Chainlink/TWAP in dev/tests)
/// @notice Stores a price per token (in debt/quote units, scaled 1e18). In production this would be
///         replaced by a Chainlink feed or the TWAPOracle; the interface (`price`) stays the same.
contract SimplePriceOracle is AccessControl {
    bytes32 public constant FEEDER_ROLE = keccak256("FEEDER_ROLE");
    mapping(address => uint256) public price;

    event PriceSet(address indexed token, uint256 price);

    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEEDER_ROLE, admin);
    }

    function setPrice(address token, uint256 p) external onlyRole(FEEDER_ROLE) {
        price[token] = p;
        emit PriceSet(token, p);
    }
}
