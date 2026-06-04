// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PoLToken} from "../contracts/PoLToken.sol";
import {VoteEscrow} from "../contracts/VoteEscrow.sol";
import {GaugeController} from "../contracts/GaugeController.sol";
import {VeVotesAdapter} from "../contracts/VeVotesAdapter.sol";
import {GovernorDAO} from "../contracts/GovernorDAO.sol";

/// @title DeployDao — hold-to-govern stack: VoteEscrow + GaugeController + ve-Governor.
/// @notice Forge script for the governance layer:
///   1. PoLToken                 — the lockable base token (env LOCK_TOKEN reuses an existing one)
///   2. VoteEscrow(token, 1y)    — Curve-style ve-lock; longer lock = more weight
///   3. GaugeController(ve)       — ve-weighted emission direction
///   4. VeVotesAdapter(ve)        — exposes live ve weight as an IVotes/ERC-6372 source
///   5. TimelockController        — execution delay; deployer self-administers for role setup
///   6. GovernorDAO(adapter, tl)  — Compound/OZ Governor voting on ve weight
///      then grants the governor PROPOSER+EXECUTOR on the timelock (open-execute too).
/// @dev Mirrors test/GovernorDAO.test.js wiring, but sources votes from ve (VeVotesAdapter)
///      rather than a plain ERC20Votes token — the "hold/lock-to-govern" design.
///
/// Run:
///   forge script script/DeployDao.s.sol:DeployDao \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
contract DeployDao is Script {
    uint256 internal constant MAX_LOCK = 365 days;
    uint256 internal constant MIN_DELAY = 3600; // 1h timelock delay

    function run()
        external
        returns (
            VoteEscrow ve,
            GaugeController gauge,
            VeVotesAdapter votes,
            TimelockController timelock,
            GovernorDAO governor
        )
    {
        address deployer = msg.sender;
        address lockToken = vm.envOr("LOCK_TOKEN", address(0));

        vm.startBroadcast();

        if (lockToken == address(0)) {
            lockToken = address(new PoLToken(deployer));
            console2.log("PoLToken (lock token):", lockToken);
        }

        ve = new VoteEscrow(IERC20(lockToken), MAX_LOCK);
        console2.log("VoteEscrow     :", address(ve));

        gauge = new GaugeController(ve);
        console2.log("GaugeController:", address(gauge));

        votes = new VeVotesAdapter(ve);
        console2.log("VeVotesAdapter :", address(votes));

        // Timelock with deployer as temporary self-admin (so we can grant roles), empty sets.
        address[] memory empty = new address[](0);
        timelock = new TimelockController(MIN_DELAY, empty, empty, deployer);
        console2.log("Timelock       :", address(timelock));

        governor = new GovernorDAO(votes, timelock);
        console2.log("GovernorDAO    :", address(governor));

        // Wire governance roles: governor proposes & executes; open execution allowed.
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(0));
        console2.log("  granted PROPOSER + EXECUTOR to governor (and open EXECUTOR)");

        vm.stopBroadcast();
    }
}
