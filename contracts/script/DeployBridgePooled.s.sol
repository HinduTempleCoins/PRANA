// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FederatedBridgeValidatorSet} from "../contracts/bridge/FederatedBridgeValidatorSet.sol";
import {GrapheneDepositBridge} from "../contracts/bridge/GrapheneDepositBridge.sol";
import {WrappedEcosystemToken} from "../contracts/compute/WrappedEcosystemToken.sol";

interface IERC20ish {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// @title DeployBridgePooled — the LOCK_RELEASE (no-mint-authority) bridge, proven on testnet.
/// @notice Deposit RELEASES wVKBT from a pre-funded pool (no mint); withdraw LOCKS it back (no burn).
///         Mint authority is renounced after funding, so wrapped supply is FIXED at the pool — no bug
///         or compromised quorum can ever inflate it (max loss = the pool). Recycle model.
contract DeployBridgePooled is Script {
    function run() external {
        address me = msg.sender; // deployer = 1-of-1 attester + admin + (temporary) custodian
        bytes32 vkbtId = keccak256(bytes("VKBT"));
        uint256 pool = 1_000_000 * 1e8; // fixed pool = the max backing cap (8-dec, HE precision)

        vm.startBroadcast();

        address[] memory validators = new address[](1);
        validators[0] = me;
        FederatedBridgeValidatorSet vset = new FederatedBridgeValidatorSet(me, validators, 1);
        GrapheneDepositBridge bridge = new GrapheneDepositBridge(me, address(vset));
        // custodian = me (so I can mint the pool ONCE); admin = me.
        WrappedEcosystemToken wvkbt = new WrappedEcosystemToken("Wrapped VKBT", "wVKBT", 8, vkbtId, me, me);
        console2.log("vset   :", address(vset));
        console2.log("bridge :", address(bridge));
        console2.log("wVKBT  :", address(wvkbt));

        // 1) register wVKBT in POOLED (lock/release) mode, 2) pre-fund the pool into the bridge,
        // 3) RENOUNCE mint authority -> supply is now permanently fixed at `pool`.
        bridge.registerTokenPooled(vkbtId, address(wvkbt));
        wvkbt.mint(address(bridge), pool, keccak256(bytes("genesis-pool")));
        wvkbt.renounceRole(wvkbt.CUSTODIAN_ROLE(), me);
        console2.log("pool funded, mint authority RENOUNCED. supply (fixed):", IERC20ish(address(wvkbt)).totalSupply());
        console2.log("bridge pool balance:", IERC20ish(address(wvkbt)).balanceOf(address(bridge)));

        vm.stopBroadcast();

        _proveCycle(bridge, wvkbt, vkbtId, me);
    }

    function _proveCycle(GrapheneDepositBridge bridge, WrappedEcosystemToken wvkbt, bytes32 vkbtId, address me)
        internal
    {
        IERC20ish w = IERC20ish(address(wvkbt));
        uint256 supply0 = w.totalSupply();
        uint256 amt = 100 * 1e8;

        vm.startBroadcast();
        // DEPOSIT: attest a Hive-Engine VKBT deposit -> RELEASE 100 wVKBT from the pool (no mint).
        bridge.attestDeposit(keccak256(bytes("he-tx-pooled-1")), vkbtId, me, amt);
        console2.log("after deposit: recipient wVKBT:", w.balanceOf(me), "| pool:", w.balanceOf(address(bridge)));
        console2.log("  totalSupply unchanged?:", w.totalSupply() == supply0);

        // WITHDRAW: burn... no — LOCK it back into the pool (no burn), emit Withdrawal for Hive release.
        wvkbt.approve(address(bridge), amt);
        uint256 nonce = bridge.withdraw(vkbtId, amt, keccak256(bytes("@vankushfamily")));
        console2.log("after withdraw: recipient wVKBT:", w.balanceOf(me), "| pool:", w.balanceOf(address(bridge)));
        console2.log("  withdraw nonce (Hive release trigger):", nonce);
        console2.log("  totalSupply STILL unchanged (never minted/burned)?:", w.totalSupply() == supply0);
        vm.stopBroadcast();
    }
}
