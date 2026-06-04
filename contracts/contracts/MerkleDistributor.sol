// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title MerkleDistributor — claimable ERC-20 airdrop with a Merkle allowlist
/// @notice Recipients claim their own allocation (and pay their own gas). The allowlist is a
///         Merkle root; each leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account,
///         amount)))) — the OpenZeppelin StandardMerkleTree double-hash leaf scheme. Double-claim
///         is blocked per index. Fund the contract by transferring the token to it after deploy.
contract MerkleDistributor {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    mapping(uint256 => bool) public claimed;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);

    constructor(IERC20 token_, bytes32 merkleRoot_) {
        require(address(token_) != address(0), "token=0");
        token = token_;
        merkleRoot = merkleRoot_;
    }

    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        require(!claimed[index], "claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "bad proof");
        claimed[index] = true;
        token.safeTransfer(account, amount);
        emit Claimed(index, account, amount);
    }
}
