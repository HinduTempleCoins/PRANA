// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GrapheneDepositBridge} from "../contracts/bridge/GrapheneDepositBridge.sol";

interface IERC20ish {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// @title TestBridgeCycle — prove the VKBT peg cycle on the PRANA testnet.
/// @notice deposit(attest) → wVKBT mints; then withdraw(burn) → Withdrawal event (Hive-side release).
/// Run: BRIDGE=0x.. WVKBT=0x.. forge script ...:TestBridgeCycle --broadcast --private-key $KEY --legacy
contract TestBridgeCycle is Script {
    function run() external {
        GrapheneDepositBridge bridge = GrapheneDepositBridge(vm.envAddress("BRIDGE"));
        IERC20ish wvkbt = IERC20ish(vm.envAddress("WVKBT"));
        bytes32 vkbtId = keccak256(bytes("VKBT"));
        address me = msg.sender; // the 1-of-1 attester AND the deposit recipient (deployer key)
        uint256 amt = 100 * 1e8; // 100 VKBT (8 decimals)
        bytes32 depositRef = keccak256(bytes("hive-engine-tx-test-0001")); // stands in for the HE tx id

        vm.startBroadcast();

        // 1) DEPOSIT side: the attester attests a VKBT deposit that happened on Hive-Engine.
        //    1-of-1 quorum + uncapped => mints wVKBT to `me` immediately.
        bridge.attestDeposit(depositRef, vkbtId, me, amt);
        console2.log("MINTED wVKBT to recipient:", wvkbt.balanceOf(me));
        console2.log("wVKBT totalSupply after deposit:", wvkbt.totalSupply());

        // 2) WITHDRAW side: burn the wrapped back to redeem the real VKBT on Hive-Engine.
        //    destinationRef carries the Hive @account the watcher releases VKBT to.
        wvkbt.approve(address(bridge), amt);
        uint256 nonce = bridge.withdraw(vkbtId, amt, keccak256(bytes("@vankushfamily")));
        console2.log("WITHDRAW nonce (Hive-side release trigger):", nonce);
        console2.log("wVKBT balance after withdraw:", wvkbt.balanceOf(me));
        console2.log("wVKBT totalSupply after withdraw (back to 0 = peg intact):", wvkbt.totalSupply());

        vm.stopBroadcast();
    }
}
