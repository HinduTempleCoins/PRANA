// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {WrappedNative} from "../contracts/WrappedNative.sol";
import {UniswapV2Factory} from "../contracts/amm/UniswapV2Factory.sol";
import {UniswapV2Router} from "../contracts/amm/UniswapV2Router.sol";

/// @title DeployAmm — MELEKSwap AMM core: WPRANA + UniswapV2 Factory + Router.
/// @notice Forge script for the AMM layer. Deploys the native wrapper (WPRANA), the V2 factory
///         (feeToSetter = deployer), and the router pointed at that factory.
/// @dev This repo's UniswapV2Router takes only the factory in its constructor (it resolves WPRANA
///      via wrapped-native handling at call sites), so WPRANA is deployed for use as the canonical
///      wrapper and logged for downstream wiring.
///
/// Run:
///   forge script script/DeployAmm.s.sol:DeployAmm \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
contract DeployAmm is Script {
    function run()
        external
        returns (WrappedNative wprana, UniswapV2Factory factory, UniswapV2Router router)
    {
        address deployer = msg.sender;

        vm.startBroadcast();

        wprana = new WrappedNative();
        console2.log("WPRANA  :", address(wprana));

        factory = new UniswapV2Factory(deployer); // feeToSetter = deployer
        console2.log("Factory :", address(factory));

        router = new UniswapV2Router(address(factory));
        console2.log("Router  :", address(router));

        vm.stopBroadcast();
    }
}
