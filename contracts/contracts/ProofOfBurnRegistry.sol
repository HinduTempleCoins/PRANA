// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title ProofOfBurnRegistry — a generic, append-only burn-receipt ledger
/// @notice Burn a token through here to get a permanent on-chain receipt any app can read
///         (the Counterparty proof-of-burn idea, generalized). The token is actually burned
///         (burnFrom, so approve first); the receipt records who/what/how-much/when/ref.
contract ProofOfBurnRegistry {
    struct Receipt {
        address who;
        address token;
        uint256 amount;
        uint64 time;
        bytes32 ref;
    }

    Receipt[] public receipts;
    mapping(address => uint256) public totalBurnedBy;     // burner => amount (across tokens)
    mapping(address => uint256) public totalBurnedOf;     // token => amount

    event Burned(uint256 indexed id, address indexed who, address indexed token, uint256 amount, bytes32 ref);

    function recordBurn(ERC20Burnable token, uint256 amount, bytes32 ref) external returns (uint256 id) {
        require(amount > 0, "amount=0");
        token.burnFrom(msg.sender, amount);
        id = receipts.length;
        receipts.push(Receipt(msg.sender, address(token), amount, uint64(block.timestamp), ref));
        totalBurnedBy[msg.sender] += amount;
        totalBurnedOf[address(token)] += amount;
        emit Burned(id, msg.sender, address(token), amount, ref);
    }

    function count() external view returns (uint256) {
        return receipts.length;
    }
}
