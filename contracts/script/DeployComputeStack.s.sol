// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

// --- compute stack ---
import {HashTaskWeightConfig} from "../contracts/compute/HashTaskWeightConfig.sol";
import {UnifiedSharesLedger} from "../contracts/compute/UnifiedSharesLedger.sol";
import {HashLaneCreditor} from "../contracts/compute/HashLaneCreditor.sol";
import {TaskVerificationGate, IAttestationActive} from "../contracts/compute/TaskVerificationGate.sol";
import {TaskRegistry} from "../contracts/compute/TaskRegistry.sol";
import {TaskLaneCreditor} from "../contracts/compute/TaskLaneCreditor.sol";
import {TaskDispatchPolicy, ITaskRegistryEnumerable} from "../contracts/compute/TaskDispatchPolicy.sol";
import {BurnStakeRegistry} from "../contracts/compute/BurnStakeRegistry.sol";
import {BurnStakeGovernanceAdapter} from "../contracts/compute/BurnStakeGovernanceAdapter.sol";
import {FixedRatioPriceSource} from "../contracts/compute/BurnStakePriceSource.sol";
import {MultiCurrencyBurnRouter} from "../contracts/compute/MultiCurrencyBurnRouter.sol";
import {HathorFeeTreasury} from "../contracts/compute/HathorFeeTreasury.sol";
import {VerifiedMachineCounter} from "../contracts/compute/VerifiedMachineCounter.sol";
import {CountercyclicalFeeOracle} from "../contracts/compute/CountercyclicalFeeOracle.sol";
import {SettlementFeeHook} from "../contracts/compute/SettlementFeeHook.sol";
import {CoordinatorRegistry} from "../contracts/compute/CoordinatorRegistry.sol";
import {JobClaimLedger} from "../contracts/compute/JobClaimLedger.sol";
import {RegentGovernance} from "../contracts/compute/RegentGovernance.sol";
import {RegentVotesAdapter} from "../contracts/compute/RegentVotesAdapter.sol";

// --- interfaces used as ctor arg types ---
import {IUnifiedSharesLedger} from "../contracts/interfaces/IUnifiedSharesLedger.sol";
import {IHashTaskWeightConfig} from "../contracts/interfaces/IHashTaskWeightConfig.sol";
import {IBurnStakeRegistry} from "../contracts/interfaces/IBurnStakeRegistry.sol";
import {IBurnStakePriceSource} from "../contracts/interfaces/IBurnStakePriceSource.sol";
import {IWorkerBeacon} from "../contracts/interfaces/IWorkerBeacon.sol";
import {ITaskRegistry} from "../contracts/interfaces/ITaskRegistry.sol";
import {ITaskVerificationGate} from "../contracts/compute/TaskVerificationGate.sol";
import {IPriceFeedView} from "../contracts/interfaces/IPriceFeedView.sol";
import {IEmissionPhaseView} from "../contracts/interfaces/IEmissionPhaseView.sol";
import {IVerifiedMachineCounter} from "../contracts/interfaces/IVerifiedMachineCounter.sol";
import {IFeeRateOracle} from "../contracts/interfaces/IFeeRateOracle.sol";

// --- external deps (verification staking + a settable price/emission source) ---
import {AttestationStakeSlash} from "../contracts/AttestationStakeSlash.sol";
import {SimplePriceOracle} from "../contracts/SimplePriceOracle.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockEmissionPhase} from "../contracts/mocks/MockEmissionPhase.sol";

/// @title DeployComputeStack (XX12) — Forge mirror of scripts/deploy-compute-stack.js.
/// @notice Deploys + WIRES the full PRANA compute stack: the unified-shares pool and its three lanes
///         (HASH / TASK / BURN), the Hathor settlement-fee mechanism, the burn-stake governance lane,
///         the permissionless-coordinator rails, and the decaying-regent governance. Every ctor
///         argument order matches the .sol sources; every role/pointer the JS script wires is wired
///         here identically.
///
/// @dev PRANA token: pass an existing burnable PRANA via env PRANA_TOKEN; if unset, a local MockERC20
///      (mintable + ERC20Burnable, which the burn lane requires) is deployed. The price feed
///      (SimplePriceOracle) and emission-phase source (MockEmissionPhase, an IEmissionPhaseView
///      stand-in for the real EmissionScheduler) are seeded so the fee oracle returns a live rate.
///
/// Run:
///   forge script script/DeployComputeStack.s.sol:DeployComputeStack \
///     --rpc-url $PRANA_RPC --broadcast --private-key $PRANA_DEPLOYER_KEY
contract DeployComputeStack is Script {
    // shared params (mirror the JS defaults)
    uint256 internal constant ONE = 1e18;
    uint256 internal constant EPOCH_LEN = 3600;
    uint256 internal constant WINDOW = 3;
    uint256 internal constant ISSUANCE = 1000 * ONE;
    uint256 internal constant BURN_WEIGHT = ONE;
    uint256 internal constant VARDIFF_MIN = 1;
    uint256 internal constant VARDIFF_MAX = 1_000_000;
    uint256 internal constant ATT_MIN_STAKE = 100 * ONE;
    uint256 internal constant COORD_MIN_BOND = 1000 * ONE;
    uint256 internal constant COORD_COOLDOWN = 7 days;
    uint256 internal constant JOB_CLAIM_WINDOW = 3600;
    uint256 internal constant VM_WINDOW = 7 days;
    uint256 internal constant VM_BUCKETS = 7;
    uint256 internal constant REGENT_INITIAL_WEIGHT = 1_000_000 * ONE;
    uint256 internal constant REGENT_DURATION = 730 days;

    // grouped return to dodge stack-too-deep; addresses logged inline as we go.
    struct Deployed {
        address prana;
        address weightConfig;
        address ledger;
        address hashCreditor;
        address attestation;
        address gate;
        address taskRegistry;
        address taskCreditor;
        address dispatchPolicy;
        address burnRegistry;
        address burnGovAdapter;
        address priceSource;
        address burnRouter;
        address feeTreasury;
        address priceFeed;
        address emissionPhase;
        address machineCounter;
        address feeOracle;
        address feeHook;
        address coordRegistry;
        address jobClaimLedger;
        address regent;
        address regentVotes;
    }

    /// @dev Each contract's ADDRESS is stored straight into `d`, and every later contract that needs a
    ///      prior one re-derives it from `d` via a cast — so run() never holds a wall of typed locals
    ///      (which overflowed the stack). Lanes are split into helpers for the same reason.
    function run() external returns (Deployed memory d) {
        address admin = msg.sender; // DEFAULT_ADMIN across the stack
        address treasury = msg.sender; // treasury/skim sink (DAO timelock in prod)

        vm.startBroadcast();

        // 0) PRANA token (reuse env PRANA_TOKEN if a burnable one exists; else a local mock).
        address pranaAddr = vm.envOr("PRANA_TOKEN", address(0));
        if (pranaAddr == address(0)) pranaAddr = address(new MockERC20("Prana", "PRANA"));
        d.prana = pranaAddr;

        // 1) HashTaskWeightConfig(admin, burnWeight, minDifficulty, maxDifficulty)
        d.weightConfig = address(new HashTaskWeightConfig(admin, BURN_WEIGHT, VARDIFF_MIN, VARDIFF_MAX));

        // 2) UnifiedSharesLedger(prana, weightConfig, admin, epochLength, windowEpochs, epochIssuance)
        d.ledger = address(
            new UnifiedSharesLedger(
                IERC20(pranaAddr), IHashTaskWeightConfig(d.weightConfig), admin, EPOCH_LEN, WINDOW, ISSUANCE
            )
        );

        // 3) HashLaneCreditor(ledger, beacon=0, admin)
        d.hashCreditor =
            address(new HashLaneCreditor(IUnifiedSharesLedger(d.ledger), IWorkerBeacon(address(0)), admin));

        // 4) TASK lane, 5) BURN lane, 6) fee mechanism — split out to keep run() shallow.
        _deployTaskLane(d, admin, treasury);
        _deployBurnLane(d, admin, pranaAddr);
        _deployFeeMechanism(d, admin, treasury, pranaAddr);

        // 7) Permissionless-coordinator rails.
        d.coordRegistry =
            address(new CoordinatorRegistry(IERC20(pranaAddr), admin, treasury, COORD_MIN_BOND, COORD_COOLDOWN));
        d.jobClaimLedger = address(new JobClaimLedger(CoordinatorRegistry(d.coordRegistry), admin, JOB_CLAIM_WINDOW));

        // 8) Regent governance.
        d.regent = address(new RegentGovernance(admin, REGENT_INITIAL_WEIGHT, 0, REGENT_DURATION));
        d.regentVotes = address(new RegentVotesAdapter(RegentGovernance(d.regent), admin));

        _wire(d, admin);
        _logSummary(d);

        vm.stopBroadcast();
    }

    /// @dev TASK lane: stake token -> attestation -> gate -> registry -> creditor -> dispatch policy.
    function _deployTaskLane(Deployed memory d, address admin, address treasury) internal {
        address stakeTok = address(new MockERC20("Attestation Stake", "ASTK"));
        d.attestation = address(new AttestationStakeSlash(IERC20(stakeTok), ATT_MIN_STAKE, treasury, admin));
        d.gate = address(new TaskVerificationGate(IAttestationActive(d.attestation), admin));
        d.taskRegistry = address(new TaskRegistry(admin));
        d.taskCreditor = address(
            new TaskLaneCreditor(
                IUnifiedSharesLedger(d.ledger),
                ITaskRegistry(d.taskRegistry),
                ITaskVerificationGate(d.gate),
                IWorkerBeacon(address(0)),
                admin
            )
        );
        d.dispatchPolicy = address(new TaskDispatchPolicy(ITaskRegistryEnumerable(d.taskRegistry), admin));
    }

    /// @dev BURN lane: registry -> governance adapter -> price source -> multi-currency router.
    function _deployBurnLane(Deployed memory d, address admin, address pranaAddr) internal {
        d.burnRegistry = address(new BurnStakeRegistry(ERC20Burnable(pranaAddr), admin));
        d.burnGovAdapter = address(new BurnStakeGovernanceAdapter(BurnStakeRegistry(d.burnRegistry)));
        d.priceSource = address(new FixedRatioPriceSource(admin));
        d.burnRouter = address(
            new MultiCurrencyBurnRouter(
                admin, IBurnStakeRegistry(d.burnRegistry), IBurnStakePriceSource(d.priceSource)
            )
        );
    }

    /// @dev Fee mechanism is split out to keep run()'s stack shallow.
    function _deployFeeMechanism(
        Deployed memory d,
        address admin,
        address treasury,
        address pranaAddr
    ) internal {
        // 6a) HathorFeeTreasury(admin, governor)
        HathorFeeTreasury feeTreasury = new HathorFeeTreasury(admin, admin);
        d.feeTreasury = address(feeTreasury);
        console2.log("HathorFeeTreasury        :", address(feeTreasury));

        // 6b) SimplePriceOracle(admin) — implements IPriceFeedView.price(token).
        SimplePriceOracle priceFeed = new SimplePriceOracle(admin);
        d.priceFeed = address(priceFeed);
        console2.log("SimplePriceOracle        :", address(priceFeed));

        // 6c) MockEmissionPhase() — IEmissionPhaseView stand-in (swap for EmissionScheduler in prod).
        MockEmissionPhase emissionPhase = new MockEmissionPhase();
        d.emissionPhase = address(emissionPhase);
        console2.log("EmissionPhaseView        :", address(emissionPhase));

        // 6d) VerifiedMachineCounter(admin, window, buckets)
        VerifiedMachineCounter counter = new VerifiedMachineCounter(admin, VM_WINDOW, VM_BUCKETS);
        d.machineCounter = address(counter);
        console2.log("VerifiedMachineCounter   :", address(counter));

        // 6e) CountercyclicalFeeOracle(admin, priceFeed, pranaToken, emission, counter, params)
        CountercyclicalFeeOracle.Params memory p = CountercyclicalFeeOracle.Params({
            floorBps: 10,
            ceilingBps: 500,
            steadyFloorBps: 10,
            steadyCeilBps: 300,
            bootstrapCeilBps: 500,
            machineThresholdX: 1000,
            refLowPrice: ONE,
            refHighPrice: 10 * ONE,
            bootstrapEpochs: 100
        });
        CountercyclicalFeeOracle feeOracle = new CountercyclicalFeeOracle(
            admin,
            IPriceFeedView(address(priceFeed)),
            pranaAddr,
            IEmissionPhaseView(address(emissionPhase)),
            IVerifiedMachineCounter(address(counter)),
            p
        );
        d.feeOracle = address(feeOracle);
        console2.log("CountercyclicalFeeOracle :", address(feeOracle));

        // 6f) SettlementFeeHook(admin, ledger, treasury, oracle) — grants LEDGER_ROLE to ledger in ctor.
        d.feeHook = address(
            new SettlementFeeHook(admin, d.ledger, address(feeTreasury), IFeeRateOracle(address(feeOracle)))
        );

        // seed a mid-band PRANA price so the oracle returns a live rate.
        priceFeed.setPrice(pranaAddr, 5 * ONE);
    }

    /// @dev All role grants + pointer wiring. Typed handles are re-derived from `d` (addresses) so the
    ///      caller never has to keep a wall of locals alive across the whole deploy.
    function _wire(Deployed memory d, address admin) internal {
        UnifiedSharesLedger ledger = UnifiedSharesLedger(d.ledger);
        // ledger lane creditor roles.
        ledger.grantRole(ledger.HASH_CREDITOR(), d.hashCreditor);
        ledger.grantRole(ledger.TASK_CREDITOR(), d.taskCreditor);
        ledger.grantRole(ledger.BURN_CREDITOR(), admin); // off-chain burn-emission keeper key
        ledger.grantRole(ledger.FUNDER_ROLE(), admin);

        // TASK lane.
        TaskVerificationGate gate = TaskVerificationGate(d.gate);
        gate.grantRole(gate.CONSUMER_ROLE(), d.taskCreditor);
        TaskRegistry(d.taskRegistry).setTaskType(keccak256("hathor-inference"), bytes32(0), d.gate, ONE, 100, true);

        // settlement fee hook (ledger.setFeeHook routes claim() through it; LEDGER_ROLE set in ctor).
        ledger.setFeeHook(d.feeHook);

        // BURN lane.
        BurnStakeRegistry burnRegistry = BurnStakeRegistry(d.burnRegistry);
        burnRegistry.setWeightHook(BurnStakeGovernanceAdapter(d.burnGovAdapter)); // checkpoint gov on each burn
        burnRegistry.grantRole(burnRegistry.BURNER_ROLE(), d.burnRouter);
        FixedRatioPriceSource(d.priceSource).setRatio(d.prana, ONE); // PRANA at parity
        MultiCurrencyBurnRouter(d.burnRouter).setCurrencyAllowed(d.prana, true); // allowlist PRANA on router
    }

    /// @dev Print the deployed address book at the end of the run.
    function _logSummary(Deployed memory d) internal pure {
        console2.log("PRANA                    :", d.prana);
        console2.log("UnifiedSharesLedger      :", d.ledger);
        console2.log("HashLaneCreditor         :", d.hashCreditor);
        console2.log("TaskLaneCreditor         :", d.taskCreditor);
        console2.log("TaskVerificationGate     :", d.gate);
        console2.log("BurnStakeRegistry        :", d.burnRegistry);
        console2.log("SettlementFeeHook        :", d.feeHook);
        console2.log("CoordinatorRegistry      :", d.coordRegistry);
        console2.log("JobClaimLedger           :", d.jobClaimLedger);
        console2.log("RegentGovernance         :", d.regent);
    }
}
