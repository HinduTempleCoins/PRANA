// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20Base} from "../contracts/ERC20Base.sol";
import {WrappedNative} from "../contracts/WrappedNative.sol";
import {UniswapV2Factory} from "../contracts/amm/UniswapV2Factory.sol";
import {UniswapV2Router} from "../contracts/amm/UniswapV2Router.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title TestnetSeedPair — prove the KulaSwap trade leg on the PRANA testnet.
/// @notice Deploys a testnet wAPIS ERC-20, seeds a wAPIS/WPRANA pool, and executes a real swap.
///         Refactored to keep run()'s stack shallow (no --via-ir needed).
/// Run: WPRANA=.. FACTORY=.. ROUTER=.. forge script ...:TestnetSeedPair --broadcast --private-key $KEY --legacy
contract TestnetSeedPair is Script {
    address wprana;
    address factory;
    address router;

    function run() external {
        wprana = vm.envAddress("WPRANA");
        factory = vm.envAddress("FACTORY");
        router = vm.envAddress("ROUTER");

        vm.startBroadcast();
        address wapis = _deployWapis(msg.sender);
        _seed(wapis, msg.sender);
        _swap(wapis, msg.sender);
        vm.stopBroadcast();
    }

    function _deployWapis(address me) internal returns (address) {
        ERC20Base wapis = new ERC20Base("Wrapped APIS", "wAPIS", 1_000_000_000 ether, me);
        wapis.mint(me, 100_000 ether);
        console2.log("wAPIS   :", address(wapis));
        return address(wapis);
    }

    function _seed(address wapis, address me) internal {
        WrappedNative(payable(wprana)).deposit{value: 100 ether}();
        address pair = UniswapV2Factory(factory).createPair(wapis, wprana);
        console2.log("Pair    :", pair);
        IERC20Min(wapis).approve(router, type(uint256).max);
        IERC20Min(wprana).approve(router, type(uint256).max);
        // 10,000 wAPIS : 100 WPRANA  (price 100 wAPIS / WPRANA)
        UniswapV2Router(router).addLiquidity(
            wapis, wprana, 10_000 ether, 100 ether, 0, 0, me, block.timestamp + 1 hours
        );
        console2.log("liquidity added (10k wAPIS / 100 WPRANA)");
    }

    function _swap(address wapis, address me) internal {
        WrappedNative(payable(wprana)).deposit{value: 1 ether}();
        address[] memory path = new address[](2);
        path[0] = wprana;
        path[1] = wapis;
        uint256[] memory outs = UniswapV2Router(router).swapExactTokensForTokens(
            1 ether, 0, path, me, block.timestamp + 1 hours
        );
        console2.log("SWAP 1 WPRANA -> wAPIS out:", outs[outs.length - 1]);
        console2.log("wAPIS balance now:", IERC20Min(wapis).balanceOf(me));
    }
}
