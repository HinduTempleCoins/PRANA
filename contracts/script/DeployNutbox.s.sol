// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20Base} from "../contracts/ERC20Base.sol";
import {DelegationMint, IMintable} from "../contracts/DelegationMint.sol";

/// @title DeployNutbox — NutBox delegation-mining → ALTI (the SoapBox token, "our PNUTs").
/// @notice Deploys ALTI (uncapped for testnet), a delegated-Power stake token, and a
///         DelegationMint pool that mints ALTI to delegators (MasterChef curve). Grants ALTI
///         MINTER_ROLE to the pool. ALTI is the reward token users earn by delegating MELEK
///         Power as a CHOICE in auto.soapbox.community; spend in the Shop / burn at the Burn Mine.
///         ALTI is a TOKEN — distinct from PRANA (the chain coin) and KULA (the farm token).
///
/// Run:
///   forge script script/DeployNutbox.s.sol:DeployNutbox \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
contract DeployNutbox is Script {
    // Uncapped for the testnet (operator: "No Cap, TestNet"). Effectively-unlimited cap.
    uint256 internal constant ALTI_CAP = type(uint256).max;
    // Default emission: 1 ALTI per block (DAO-tunable later).
    uint256 internal constant EMISSION_PER_BLOCK = 1 ether;

    function run() external returns (ERC20Base alti, ERC20Base stake, DelegationMint pool) {
        address admin = msg.sender;
        uint256 emission = vm.envOr("ALTI_EMISSION_PER_BLOCK", EMISSION_PER_BLOCK);

        vm.startBroadcast();

        // ALTI — the delegation-mining reward token (uncapped, testnet).
        alti = new ERC20Base("Alti", "ALTI", ALTI_CAP, admin);
        console2.log("ALTI:", address(alti));

        // Delegated-MELEK-Power proxy: the ERC-20 a delegator stakes into the pool. On the live
        // path this is minted by the bridge/relayer from a MELEK Power delegation; here it is a
        // testnet stand-in so the pool can be exercised end to end.
        stake = new ERC20Base("Delegated MELEK Power", "dMP", type(uint256).max, admin);
        console2.log("dMP (delegated-power stake token):", address(stake));

        pool = new DelegationMint(stake, IMintable(address(alti)), emission);
        console2.log("DelegationMint (ALTI pool):", address(pool));
        console2.log("  emissionPerBlock:", emission);

        // The pool must be able to mint ALTI.
        alti.grantRole(alti.MINTER_ROLE(), address(pool));
        console2.log("granted ALTI MINTER_ROLE -> DelegationMint");

        // Seed the deployer with some dMP so the pool can be smoke-tested.
        stake.mint(admin, 1_000 ether);
        console2.log("minted 1000 dMP to deployer for testing");

        vm.stopBroadcast();
    }
}
