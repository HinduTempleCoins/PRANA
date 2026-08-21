// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GrapheneDepositBridge} from "../contracts/bridge/GrapheneDepositBridge.sol";
import {WrappedNative} from "../contracts/WrappedNative.sol";
import {UniswapV2Factory} from "../contracts/amm/UniswapV2Factory.sol";
import {UniswapV2Router} from "../contracts/amm/UniswapV2Router.sol";

interface IERC20ish {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title DeployWvkbtPair — close the loop: bridge wVKBT out, list it on KulaSwap, prove a swap.
/// Env: BRIDGE, WVKBT, WPRANA, FACTORY, ROUTER.
contract DeployWvkbtPair is Script {
    address b; address w; address wp; address f; address r;

    function run() external {
        b = vm.envAddress("BRIDGE"); w = vm.envAddress("WVKBT"); wp = vm.envAddress("WPRANA");
        f = vm.envAddress("FACTORY"); r = vm.envAddress("ROUTER");
        address me = msg.sender;

        vm.startBroadcast();
        // 1) release wVKBT from the pooled bridge to me (a real bridge deposit, 1-of-1 quorum).
        GrapheneDepositBridge(b).attestDeposit(keccak256(bytes("he-tx-pair-seed")), keccak256(bytes("VKBT")), me, 500_000 * 1e8);
        console2.log("wVKBT released to trader:", IERC20ish(w).balanceOf(me));
        _seedAndSwap(me);
        vm.stopBroadcast();
    }

    function _seedAndSwap(address me) internal {
        WrappedNative(payable(wp)).deposit{value: 100 ether}();
        address pair = UniswapV2Factory(f).createPair(w, wp);
        console2.log("pair wVKBT/WPRANA:", pair);
        IERC20ish(w).approve(r, type(uint256).max);
        IERC20ish(wp).approve(r, type(uint256).max);
        // 400,000 wVKBT : 80 WPRANA
        UniswapV2Router(r).addLiquidity(w, wp, 400_000 * 1e8, 80 ether, 0, 0, me, block.timestamp + 1 hours);
        console2.log("liquidity added (400k wVKBT / 80 WPRANA)");

        WrappedNative(payable(wp)).deposit{value: 1 ether}();
        address[] memory path = new address[](2);
        path[0] = wp; path[1] = w;
        uint256[] memory outs = UniswapV2Router(r).swapExactTokensForTokens(1 ether, 0, path, me, block.timestamp + 1 hours);
        console2.log("SWAP 1 WPRANA -> wVKBT out:", outs[outs.length - 1]);
    }
}
