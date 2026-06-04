// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MineableERC20
/// @notice An EIP-918-style mineable ERC-20 token (the 0xBitcoin idea).
///         Miners search for a nonce that, hashed together with the current
///         challenge and the miner's address, produces a digest below a fixed
///         mining target. A valid solution mints a fixed reward and rolls a new
///         challenge. Difficulty is fixed (no retarget).
contract MineableERC20 is ERC20 {
    /// @notice Current mining challenge; changes after every successful mint.
    bytes32 public challengeNumber;

    /// @notice Solutions are valid when uint256(digest) <= miningTarget.
    uint256 public miningTarget;

    /// @notice Amount minted to the miner on each successful solution.
    uint256 public reward;

    /// @notice Emitted on every successful mint.
    event Mint(address indexed miner, uint256 reward, bytes32 newChallengeNumber, bytes32 digest);

    /// @param _miningTarget Fixed difficulty target (higher = easier).
    /// @param _reward Tokens minted per solved block.
    constructor(uint256 _miningTarget, uint256 _reward) ERC20("MineableERC20", "MINE") {
        miningTarget = _miningTarget;
        reward = _reward;
        // Seed the initial challenge from deployment context.
        challengeNumber = keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, msg.sender));
    }

    /// @notice Submit a nonce to attempt to mine the current challenge.
    /// @param nonce Miner-chosen value to satisfy the difficulty target.
    function mint(uint256 nonce) external returns (bool) {
        bytes32 digest = keccak256(abi.encodePacked(challengeNumber, msg.sender, nonce));
        require(uint256(digest) <= miningTarget, "difficulty");

        // Roll a new challenge derived from the previous challenge + solution.
        bytes32 newChallenge = keccak256(abi.encodePacked(challengeNumber, digest));
        challengeNumber = newChallenge;

        _mint(msg.sender, reward);

        emit Mint(msg.sender, reward, newChallenge, digest);
        return true;
    }
}
