// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "./interfaces/IUniswapV2Pair.sol";
import {UniswapV2Library} from "./UniswapV2Router.sol";

interface IERC20RouterFoTMinimal {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title UniswapV2RouterFoT
/// @notice Fee-on-transfer-safe swap router, ported from the canonical Uniswap V2 periphery
///         (`*SupportingFeeOnTransferTokens`). Kept as a SEPARATE contract from UniswapV2Router
///         so existing router tests are untouched; it shares the same UniswapV2Library pricing
///         and the same factory.
/// @dev The key difference from the plain router: instead of pre-computing amounts with
///      getAmountsOut and trusting the requested input, each hop MEASURES the pair's actual
///      input-token balance delta (reserveInput vs current balance) and prices off that. This
///      makes the swap correct even when a token skims a fee on transfer, so the recipient is
///      never short-changed relative to what actually arrived. The trade-off is the slippage
///      check moves to the final output balance delta (amountOutMin) since per-hop outputs are
///      not known up-front. ERC20/ERC20 only — the base router has no native/ETH paths, so this
///      one mirrors that and provides no ETH/WPRANA variants.
contract UniswapV2RouterFoT {
    address public immutable factory;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "UniswapV2RouterFoT: EXPIRED");
        _;
    }

    constructor(address _factory) {
        factory = _factory;
    }

    // **** SWAP (supporting fee-on-transfer tokens) ****
    // requires the initial amount to have already been sent to the first pair
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = UniswapV2Library.sortTokens(input, output);
            IUniswapV2Pair pair = IUniswapV2Pair(UniswapV2Library.pairFor(factory, input, output));
            uint256 amountInput;
            uint256 amountOutput;
            {
                // scope to avoid stack-too-deep
                (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) = input == token0
                    ? (reserve0, reserve1)
                    : (reserve1, reserve0);
                // the actual amount that arrived at the pair (post fee-on-transfer)
                amountInput = IERC20RouterFoTMinimal(input).balanceOf(address(pair)) - reserveInput;
                amountOutput = UniswapV2Library.getAmountOut(amountInput, reserveInput, reserveOutput);
            }
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOutput)
                : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? UniswapV2Library.pairFor(factory, output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        require(path.length >= 2, "UniswapV2RouterFoT: INVALID_PATH");
        _safeTransferFrom(
            path[0],
            msg.sender,
            UniswapV2Library.pairFor(factory, path[0], path[1]),
            amountIn
        );
        uint256 balanceBefore = IERC20RouterFoTMinimal(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20RouterFoTMinimal(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "UniswapV2RouterFoT: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20RouterFoTMinimal.transferFrom.selector, from, to, value)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "UniswapV2RouterFoT: TRANSFER_FROM_FAILED");
    }
}
