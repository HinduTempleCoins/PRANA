// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PoLToken} from "../contracts/PoLToken.sol";
import {BurnMine, IMintable} from "../contracts/BurnMine.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title DeployCore — token-engine core: PoLToken (mintable output) + a BurnMine wired to it.
/// @notice Forge mirror of the token-engine slice of scripts/deploy-core.js.
///         Deploys the Proof-of-Liquidity reward token and a BurnMine that mints it, granting
///         the mine MINTER_ROLE so the burn-to-mint path works end to end.
/// @dev The burnable INPUT token is a deployment parameter (env BURN_INPUT) because a real
///      burn-mine consumes a pre-existing token; defaults to a placeholder for dry-runs.
///
/// Run:
///   forge script script/DeployCore.s.sol:DeployCore \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
contract DeployCore is Script {
    // ratioNum:ratioDen = 10:1  → burn 1 input, mint 10 PoL (matches deploy-core.js).
    uint256 internal constant RATIO_NUM = 10;
    uint256 internal constant RATIO_DEN = 1;

    function run() external returns (PoLToken pol, BurnMine mine) {
        address deployer = msg.sender;
        // Optional pre-existing burnable input token; 0 → skip the mine (token-only deploy).
        address burnInput = vm.envOr("BURN_INPUT", address(0));

        vm.startBroadcast();

        pol = new PoLToken(deployer);
        console2.log("PoLToken:", address(pol));

        if (burnInput != address(0)) {
            mine = new BurnMine(ERC20Burnable(burnInput), IMintable(address(pol)), RATIO_NUM, RATIO_DEN);
            pol.grantRole(pol.MINTER_ROLE(), address(mine));
            console2.log("BurnMine:", address(mine));
            console2.log("  input :", burnInput);
            console2.log("  granted PoL MINTER_ROLE to BurnMine");
        } else {
            console2.log("BurnMine: SKIPPED (set BURN_INPUT to a burnable ERC20 to deploy it)");
        }

        vm.stopBroadcast();
    }
}
