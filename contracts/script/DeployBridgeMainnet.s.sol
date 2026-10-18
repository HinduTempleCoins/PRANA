// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FederatedBridgeValidatorSet} from "../contracts/bridge/FederatedBridgeValidatorSet.sol";
import {GrapheneDepositBridge} from "../contracts/bridge/GrapheneDepositBridge.sol";
import {WrappedTokenFactory} from "../contracts/compute/WrappedTokenFactory.sol";

/// @title DeployBridgeMainnet — PRANA mainnet (chainId 712217) wrapped-asset bridge, K-of-N = 3-of-5.
/// @notice Serialized single-deployer deploy of the HARDENED Graphene deposit bridge:
///           FederatedBridgeValidatorSet(admin, 5 validators, threshold 3)
///           -> GrapheneDepositBridge(admin, vset)   [Pausable, threshold() wired, dailyMintCap]
///           -> WrappedTokenFactory
///           -> wMELEK (18dec, keccak256("MELEK")), wVKBT (8dec, keccak256("VKBT")),
///              wCURE (8dec, keccak256("CURE")), each with custodian = the bridge (CUSTODIAN_ROLE),
///              registered in the bridge, with a conservative per-token dailyMintCap.
///         NOTHING is minted; no deposit is attested; no pair is seeded.
contract DeployBridgeMainnet is Script {
    function run() external {
        address admin = vm.envOr("ADMIN", msg.sender);
        address[] memory validators = vm.envAddress("VALIDATORS", ",");
        uint256 threshold = vm.envUint("THRESHOLD");
        require(validators.length == 5, "expected 5 validators");
        require(threshold == 3, "expected threshold 3");

        vm.startBroadcast();

        FederatedBridgeValidatorSet vset = new FederatedBridgeValidatorSet(admin, validators, threshold);
        console2.log("FederatedBridgeValidatorSet:", address(vset));

        GrapheneDepositBridge bridge = new GrapheneDepositBridge(admin, address(vset));
        console2.log("GrapheneDepositBridge:", address(bridge));

        WrappedTokenFactory factory = new WrappedTokenFactory();
        console2.log("WrappedTokenFactory:", address(factory));

        _wrap(factory, bridge, admin, "Wrapped MELEK", "wMELEK", 18, keccak256(bytes("MELEK")), vm.envUint("CAP_MELEK"));
        _wrap(factory, bridge, admin, "Wrapped VKBT", "wVKBT", 8, keccak256(bytes("VKBT")), vm.envUint("CAP_VKBT"));
        _wrap(factory, bridge, admin, "Wrapped CURE", "wCURE", 8, keccak256(bytes("CURE")), vm.envUint("CAP_CURE"));

        vm.stopBroadcast();
    }

    function _wrap(
        WrappedTokenFactory factory,
        GrapheneDepositBridge bridge,
        address admin,
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        bytes32 tokenId,
        uint256 cap
    ) internal {
        address w = factory.createWrapped(name_, symbol_, decimals_, tokenId, admin, address(bridge));
        bridge.registerToken(tokenId, w);
        bridge.setDailyMintCap(tokenId, cap);
        console2.log(symbol_, w);
        console2.log("  dailyMintCap:", cap);
    }
}
