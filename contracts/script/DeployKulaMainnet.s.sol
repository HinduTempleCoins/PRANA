// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {KULA} from "../contracts/KULA.sol";
import {Mwali} from "../contracts/Mwali.sol";
import {MelekBorrowNote} from "../contracts/MelekBorrowNote.sol";
import {VoteEscrow} from "../contracts/VoteEscrow.sol";
import {GaugeController} from "../contracts/GaugeController.sol";
import {LiquidityGauge} from "../contracts/LiquidityGauge.sol";
import {DividendDistributor} from "../contracts/DividendDistributor.sol";
import {NoLossLotto} from "../contracts/NoLossLotto.sol";
import {CDPVault} from "../contracts/CDPVault.sol";
import {SimplePriceOracle} from "../contracts/SimplePriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMintable} from "../contracts/BurnMine.sol";

interface IFactory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

/// @title DeployKulaMainnet — deploy + wire the KULA DeFi farm on PRANA mainnet (chainId 712217).
/// @notice REUSES the already-live KULA token + AMM + EmissionScheduler (passed by env); deploys the
///         ve/gauge/dividend/lotto/CDP sinks and the emission-only MWALI, then wires roles. KULA
///         MINTER_ROLE is granted ONLY to the existing EmissionScheduler (sole emission contract).
///         DEFAULT_ADMIN handoff to the timelock is done SEPARATELY, after on-chain verification.
contract DeployKulaMainnet is Script {
    struct Dep {
        address pair;
        address ve;
        address gc;
        address lpGauge;
        address stakers;
        address miners;
        address lotto;
        address mwali;
        address oracle;
        address note;
        address cdp;
    }

    function run() external {
        address admin = msg.sender; // deployer == keeper
        address kula = vm.envAddress("KULA");
        address wprana = vm.envAddress("WPRANA");
        address prana = vm.envAddress("PRANA");
        address factory = vm.envAddress("FACTORY");
        address scheduler = vm.envAddress("SCHEDULER");
        uint256 maxLock = vm.envOr("VE_MAXLOCK", uint256(4 * 365 * 86400));
        uint256 maxLTV = vm.envOr("CDP_MAXLTV", uint256(5e17));
        uint256 kulaPrice = vm.envOr("KULA_PRICE", uint256(1e18));

        Dep memory d;
        vm.startBroadcast();

        d.pair = IFactory(factory).getPair(kula, wprana);
        if (d.pair == address(0)) d.pair = IFactory(factory).createPair(kula, wprana);

        d.ve = address(new VoteEscrow(IERC20(kula), maxLock));
        d.gc = address(new GaugeController(VoteEscrow(d.ve)));
        d.lpGauge = address(new LiquidityGauge(IERC20(d.pair), IERC20(kula), admin));
        d.stakers = address(new DividendDistributor(IERC20(kula), IERC20(kula)));
        d.miners = address(new DividendDistributor(IERC20(prana), IERC20(kula)));
        d.lotto = address(new NoLossLotto(IERC20(kula), admin));
        d.mwali = address(new Mwali(admin));
        d.oracle = address(new SimplePriceOracle(admin));
        d.note = address(new MelekBorrowNote(admin));
        d.cdp = address(new CDPVault(IERC20(kula), IMintable(d.note), SimplePriceOracle(d.oracle), maxLTV));

        GaugeController(d.gc).addGauge(d.lpGauge);
        Mwali(d.mwali).grantRole(Mwali(d.mwali).MINTER_ROLE(), d.lpGauge);
        MelekBorrowNote(d.note).grantRole(MelekBorrowNote(d.note).MINTER_ROLE(), d.cdp);
        SimplePriceOracle(d.oracle).setPrice(kula, kulaPrice);
        KULA(kula).grantRole(KULA(kula).MINTER_ROLE(), scheduler);

        vm.stopBroadcast();
        _log(d);
    }

    function _log(Dep memory d) internal pure {
        console2.log("PAIR_KULA_WPRANA", d.pair);
        console2.log("VOTE_ESCROW", d.ve);
        console2.log("GAUGE_CONTROLLER", d.gc);
        console2.log("LP_GAUGE", d.lpGauge);
        console2.log("DIVIDEND_STAKERS", d.stakers);
        console2.log("DIVIDEND_MINERS", d.miners);
        console2.log("NO_LOSS_LOTTO", d.lotto);
        console2.log("MWALI", d.mwali);
        console2.log("PRICE_ORACLE", d.oracle);
        console2.log("MELEK_BORROW_NOTE", d.note);
        console2.log("CDP_VAULT", d.cdp);
    }
}
