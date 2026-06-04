// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Merkle airdrop with a hard claim deadline and post-deadline owner sweep.
/// @dev Leaf scheme matches OpenZeppelin StandardMerkleTree (double keccak256):
///      leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount)))).
contract MerkleClaimDeadline is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint64 public immutable deadline;

    mapping(uint256 => bool) public claimed;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    constructor(IERC20 token_, bytes32 merkleRoot_, uint64 deadline_, address owner_) Ownable(owner_) {
        token = token_;
        merkleRoot = merkleRoot_;
        deadline = deadline_;
    }

    /// @notice Claim an allocation before the deadline against the Merkle root.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        require(block.timestamp <= deadline, "deadline passed");
        require(!claimed[index], "claimed");

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "bad proof");

        claimed[index] = true;
        token.safeTransfer(account, amount);

        emit Claimed(index, account, amount);
    }

    /// @notice After the deadline, the owner reclaims the remaining (unclaimed) balance.
    function sweep(address to) external onlyOwner {
        require(block.timestamp > deadline, "not ended");
        uint256 bal = token.balanceOf(address(this));
        token.safeTransfer(to, bal);
        emit Swept(to, bal);
    }
}
