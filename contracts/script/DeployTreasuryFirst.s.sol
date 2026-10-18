// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HathorFeeTreasury} from "../contracts/compute/HathorFeeTreasury.sol";

/// @title DeployTreasuryFirst — the launch-critical, run-me-FIRST deploy step.
///
/// The PRANA mainnet genesis seals `feeAddress = 0xF129608bF3BA681012CF82DFfCfBB92563df987e`, into which
/// the consensus layer pays the protocol block fee (feeBps 200 = 2%). That address is
/// getCreateAddress(deployer 0x026d69cB54B82a805b6aaE60718C4877124D8d11, nonce 0) — i.e. it is ONLY
/// correct if the dedicated deployer's very FIRST transaction is this HathorFeeTreasury.
///
/// If any other contract is deployed by this key first (e.g. deploy-core.js deploys PoLToken at nonce 0),
/// that contract seizes the feeAddress and 2% of EVERY block is paid to a contract that cannot disburse
/// it — irreversibly. This script makes that mistake impossible:
///   1. it refuses to run unless the deployer's nonce is 0 (fail-closed), and
///   2. it reverts unless the treasury lands at exactly the sealed feeAddress (fail-closed).
///
/// RUN THIS BEFORE deploy-defi-core.sh / dev-stack.sh / any other deploy, with the SEALED deployer key:
///   PRANA_DEPLOYER_KEY=<0x…> forge script script/DeployTreasuryFirst.s.sol:DeployTreasuryFirst \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
/// Then record the printed address in deployments.json and have the rest of the suite REUSE it.
contract DeployTreasuryFirst is Script {
    /// The genesis-sealed protocol-fee address. Treasury MUST deploy to exactly this.
    address constant SEALED_FEE_ADDRESS = 0xF129608bF3BA681012CF82DFfCfBB92563df987e;

    function run() external returns (address treasuryAddr) {
        uint256 pk = vm.envUint("PRANA_DEPLOYER_KEY");
        address deployer = vm.addr(pk);

        uint64 nonce = vm.getNonce(deployer);
        console2.log("Deployer         :", deployer);
        console2.log("Deployer nonce   :", nonce);
        require(nonce == 0, "ABORT: deployer nonce != 0 -- treasury must be its FIRST tx (feeAddress would mismatch)");

        vm.startBroadcast(pk);
        // Constructor args do NOT affect the CREATE address (it is f(sender, nonce) only); admin/governor
        // are set to the deployer and can be handed to governance post-launch.
        HathorFeeTreasury treasury = new HathorFeeTreasury(deployer, deployer);
        vm.stopBroadcast();

        treasuryAddr = address(treasury);
        console2.log("HathorFeeTreasury:", treasuryAddr);
        console2.log("Sealed feeAddress:", SEALED_FEE_ADDRESS);
        require(
            treasuryAddr == SEALED_FEE_ADDRESS,
            "ABORT: treasury address != sealed feeAddress -- do NOT proceed, 2%/block would burn"
        );
        console2.log("MATCH: treasury == sealed feeAddress. Safe to continue with the rest of the suite.");
    }
}
