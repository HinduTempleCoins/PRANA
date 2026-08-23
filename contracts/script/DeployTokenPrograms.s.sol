// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BatchAirdrop} from "../contracts/BatchAirdrop.sol";
import {ContributionBountyEscrow} from "../contracts/ContributionBountyEscrow.sol";
import {ERC20Base} from "../contracts/ERC20Base.sol";

interface IERC20ish {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function mint(address, uint256) external;
}

/// @title DeployTokenPrograms — the airdrop + bounty rails on PRANA testnet, proven end to end.
/// @notice Deploys BatchAirdrop + ContributionBountyEscrow + a demo token; proves an airdrop to 3
///         recipients and a bounty post→release. These are the on-chain targets the Bot-side
///         token-programs.mjs orchestrator emits calls for.
contract DeployTokenPrograms is Script {
    function run() external {
        address me = msg.sender;
        vm.startBroadcast();

        ERC20Base token = new ERC20Base("Program Token", "PROG", 1_000_000_000 ether, me);
        token.mint(me, 1_000_000 ether);
        BatchAirdrop air = new BatchAirdrop();
        ContributionBountyEscrow escrow = new ContributionBountyEscrow(token, me);
        console2.log("token         :", address(token));
        console2.log("BatchAirdrop  :", address(air));
        console2.log("BountyEscrow  :", address(escrow));

        // ---- AIRDROP: 3 recipients, proportional amounts (mirrors planAirdrop calls[0].args) ----
        address a1 = address(uint160(0xA11CE)); address a2 = address(uint160(0xB0B)); address a3 = address(uint160(0xCA11));
        address[] memory rcpts = new address[](3);
        rcpts[0] = a1; rcpts[1] = a2; rcpts[2] = a3;
        uint256[] memory amts = new uint256[](3);
        amts[0] = 750 ether; amts[1] = 150 ether; amts[2] = 100 ether;
        IERC20ish(address(token)).approve(address(air), 1000 ether);
        air.airdrop(token, rcpts, amts);
        console2.log("airdrop done. r1:", IERC20ish(address(token)).balanceOf(a1));
        console2.log("  r2:", IERC20ish(address(token)).balanceOf(a2), " r3:", IERC20ish(address(token)).balanceOf(a3));

        // ---- BOUNTY: post an escrowed reward, then attest+release to a worker ----
        address worker = address(uint160(0x0FF1CE));
        IERC20ish(address(token)).approve(address(escrow), 50 ether);
        uint256 id = escrow.post(50 ether);
        console2.log("bounty posted id:", id);
        escrow.attestAndRelease(id, worker);
        console2.log("bounty released to worker:", IERC20ish(address(token)).balanceOf(worker));

        vm.stopBroadcast();
    }
}
