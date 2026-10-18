// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title LockdownKula — move the emission tokens DEFAULT_ADMIN_ROLE to a TimelockController so no key
///        can add a minter without a mandatory public delay. Deploys the timelock (proposer=deployer,
///        open executor, no standing admin), then for KULA + MWALI + MelekBorrowNote grants admin to
///        the timelock and RENOUNCES the deployer admin (irreversible). All MINTER_ROLEs are already
///        assigned to their emission contracts before this runs.
contract LockdownKula is Script {
    function run() external {
        address deployer = msg.sender;
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(172800)); // 2 days
        bytes32 ADMIN = 0x00;
        address kula = vm.envAddress("KULA");
        address mwali = vm.envAddress("MWALI");
        address note = vm.envAddress("NOTE");

        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open executor

        vm.startBroadcast();
        TimelockController tl = new TimelockController(delay, proposers, executors, address(0));
        address t = address(tl);

        IAccessControl(kula).grantRole(ADMIN, t);
        IAccessControl(kula).renounceRole(ADMIN, deployer);
        IAccessControl(mwali).grantRole(ADMIN, t);
        IAccessControl(mwali).renounceRole(ADMIN, deployer);
        IAccessControl(note).grantRole(ADMIN, t);
        IAccessControl(note).renounceRole(ADMIN, deployer);
        vm.stopBroadcast();

        console2.log("TIMELOCK", t);
        console2.log("TIMELOCK_DELAY", delay);
    }
}
