// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Create2Deployer} from "../contracts/Create2Deployer.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @title DeployCreate2Deployer — forge script to deploy the deterministic deployer itself.
/// @notice Run with:
///   forge script script/Create2Deployer.s.sol:DeployCreate2Deployer \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
/// @dev Without --broadcast this is a dry-run (simulation) and is safe to execute in CI.
contract DeployCreate2Deployer is Script {
    function run() external returns (Create2Deployer deployer) {
        vm.startBroadcast();
        deployer = new Create2Deployer();
        console2.log("Create2Deployer deployed at:", address(deployer));
        vm.stopBroadcast();
    }
}
