// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title BurnMine — fixed-ratio burn-to-mint
/// @notice The simplest, safest burn-mine: pull in an input token, BURN it (a real supply sink),
///         and mint an output token at a fixed ratio:  amountOut = amountIn * ratioNum / ratioDen.
///         Requirements:
///           - `input` must be ERC20Burnable (we burn what we pull in).
///           - this contract must hold the minter authority on `output` (e.g. MINTER_ROLE).
///         Deliberately minimal and immutable — no admin, no pause, no upgrade — so it is easy to
///         audit and cannot be rug-configured after deploy. Mesh by pointing one mine's output at
///         another mine's input.
contract BurnMine {
    using SafeERC20 for IERC20;

    ERC20Burnable public immutable input;
    IMintable public immutable output;
    uint256 public immutable ratioNum;
    uint256 public immutable ratioDen;

    uint256 public totalBurned;
    uint256 public totalMinted;

    event Mined(address indexed who, uint256 amountIn, uint256 amountOut);

    constructor(ERC20Burnable input_, IMintable output_, uint256 ratioNum_, uint256 ratioDen_) {
        require(address(input_) != address(0) && address(output_) != address(0), "zero addr");
        require(ratioNum_ > 0 && ratioDen_ > 0, "bad ratio");
        input = input_;
        output = output_;
        ratioNum = ratioNum_;
        ratioDen = ratioDen_;
    }

    /// @notice Preview the output for a given input without state change.
    function quote(uint256 amountIn) public view returns (uint256) {
        return (amountIn * ratioNum) / ratioDen;
    }

    /// @notice Burn `amountIn` of the input token; mint the ratio'd amount of the output to caller.
    /// @dev Caller must first approve this contract to spend `amountIn` of the input token.
    function mine(uint256 amountIn) external returns (uint256 amountOut) {
        require(amountIn > 0, "amount=0");
        amountOut = quote(amountIn);
        require(amountOut > 0, "out=0");

        // Pull the input in, then burn it from this contract's own balance — a true sink.
        IERC20(address(input)).safeTransferFrom(msg.sender, address(this), amountIn);
        input.burn(amountIn);

        totalBurned += amountIn;
        totalMinted += amountOut;

        output.mint(msg.sender, amountOut);
        emit Mined(msg.sender, amountIn, amountOut);
    }
}
