// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FederatedBridgeValidatorSet} from "../contracts/bridge/FederatedBridgeValidatorSet.sol";
import {GrapheneDepositBridge} from "../contracts/bridge/GrapheneDepositBridge.sol";
import {WrappedEcosystemToken} from "../contracts/compute/WrappedEcosystemToken.sol";

/// @title DeployBridge — MELEK <-> PRANA deposit bridge (testnet, K-of-N = 1-of-1).
/// @notice Stands up the federated validator set (single attester for the testnet smoke test),
///         the GrapheneDepositBridge wired to it, and a wMELEK wrapper the bridge can mint.
///         Registers wMELEK under tokenId = keccak256("MELEK"). The wrapper's CUSTODIAN_ROLE is
///         granted to the bridge in the wrapper constructor so attested deposits can mint.
///
/// Run:
///   ATTESTER=0x... forge script script/DeployBridge.s.sol:DeployBridge \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
contract DeployBridge is Script {
    function run()
        external
        returns (FederatedBridgeValidatorSet vset, GrapheneDepositBridge bridge, WrappedEcosystemToken wmelek)
    {
        address admin = msg.sender;
        // Single attester for the testnet (1-of-1). Defaults to the deployer; override with ATTESTER.
        address attester = vm.envOr("ATTESTER", admin);
        bytes32 tokenId = keccak256(bytes("MELEK"));

        vm.startBroadcast();

        address[] memory validators = new address[](1);
        validators[0] = attester;
        vset = new FederatedBridgeValidatorSet(admin, validators, 1);
        console2.log("FederatedBridgeValidatorSet:", address(vset));
        console2.log("  validator (1-of-1):", attester);

        bridge = new GrapheneDepositBridge(admin, address(vset));
        console2.log("GrapheneDepositBridge:", address(bridge));

        // wMELEK — bridge is the custodian (granted CUSTODIAN_ROLE in the constructor).
        wmelek = new WrappedEcosystemToken("Wrapped MELEK", "wMELEK", 18, tokenId, admin, address(bridge));
        console2.log("WrappedEcosystemToken (wMELEK):", address(wmelek));

        bridge.registerToken(tokenId, address(wmelek));
        console2.log("registered tokenId keccak(MELEK) -> wMELEK");

        vm.stopBroadcast();
    }
}
