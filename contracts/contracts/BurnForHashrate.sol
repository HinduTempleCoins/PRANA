// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IMintable} from "./BurnMine.sol";

/// @title BurnForHashrate — virtual mining (the 0xBTC / Bitcoineum model)
/// @notice Each epoch a fixed `rewardPerEpoch` of the output token is split pro-rata among everyone
///         who BURNED the input token that epoch. "Difficulty" rises for free: fixed reward ÷ rising
///         total burn = falling yield. Competitive, not yield — you can get back less than you burned,
///         exactly like real miners (so the output must have real utility). Claim after the epoch ends.
contract BurnForHashrate {
    using SafeERC20 for IERC20;

    ERC20Burnable public immutable input;
    IMintable public immutable output;
    uint256 public immutable rewardPerEpoch;
    uint64 public immutable epochLength;
    uint64 public immutable start;

    mapping(uint64 => uint256) public epochBurned;
    mapping(uint64 => mapping(address => uint256)) public userBurned;
    mapping(uint64 => mapping(address => bool)) public claimed;

    event Burned(uint64 indexed epoch, address indexed user, uint256 amount);
    event Claimed(uint64 indexed epoch, address indexed user, uint256 reward);

    constructor(ERC20Burnable input_, IMintable output_, uint256 rewardPerEpoch_, uint64 epochLength_) {
        require(address(input_) != address(0) && address(output_) != address(0), "zero");
        require(rewardPerEpoch_ > 0 && epochLength_ > 0, "bad params");
        input = input_;
        output = output_;
        rewardPerEpoch = rewardPerEpoch_;
        epochLength = epochLength_;
        start = uint64(block.timestamp);
    }

    function currentEpoch() public view returns (uint64) {
        return (uint64(block.timestamp) - start) / epochLength;
    }

    /// @notice Burn `amount` of input toward this epoch's reward share.
    function burn(uint256 amount) external {
        require(amount > 0, "amount=0");
        uint64 e = currentEpoch();
        IERC20(address(input)).safeTransferFrom(msg.sender, address(this), amount);
        input.burn(amount);
        epochBurned[e] += amount;
        userBurned[e][msg.sender] += amount;
        emit Burned(e, msg.sender, amount);
    }

    /// @notice Claim your pro-rata mint for a finished epoch.
    function claim(uint64 epoch) external returns (uint256 reward) {
        require(epoch < currentEpoch(), "epoch not ended");
        require(!claimed[epoch][msg.sender], "claimed");
        uint256 ub = userBurned[epoch][msg.sender];
        require(ub > 0, "nothing");
        claimed[epoch][msg.sender] = true;
        reward = (rewardPerEpoch * ub) / epochBurned[epoch];
        output.mint(msg.sender, reward);
        emit Claimed(epoch, msg.sender, reward);
    }
}
