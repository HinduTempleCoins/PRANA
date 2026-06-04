// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UnifiedSharesLedger} from "../../contracts/compute/UnifiedSharesLedger.sol";
import {HashTaskWeightConfig} from "../../contracts/compute/HashTaskWeightConfig.sol";
import {EpochManager} from "../../contracts/compute/EpochManager.sol";
import {IUnifiedSharesLedger} from "../../contracts/interfaces/IUnifiedSharesLedger.sol";
import {FixtureERC20} from "../helpers/Fixtures.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

/// @title USLHandler — bounded random driver for the UnifiedSharesLedger PPLNS pool.
/// @notice Exposes three fuzz entrypoints the invariant runner calls in random order:
///           - creditRandom(): credits a bounded lane-native amount to a rotating actor in the
///             CURRENT epoch (through the matching lane creditor role this handler holds).
///           - advanceEpochs(): warps block.timestamp forward by 1..N epochs (closing epochs).
///           - claimRandom(): a rotating actor claims a rotating CLOSED epoch (idempotent).
///         It maintains independent ghost accumulators per epoch (sumCredited / sumClaimed) so the
///         invariant assertions check the contract against numbers tracked outside it.
contract USLHandler is Test {
    UnifiedSharesLedger public immutable ledger;
    FixtureERC20 public immutable prana;
    uint256 public immutable epochLength;
    uint256 public immutable issuance;

    address[] internal actors;

    // Ghost state. epoch => total lane-native credited (BURN/HASH/TASK all weight 1x here, so
    // pooled == credited and the ghost mirrors totalPoolShares exactly).
    mapping(uint256 => uint256) public ghostPooled;
    // epoch => sum of PRANA actually paid out for that epoch (across all claimers).
    mapping(uint256 => uint256) public ghostPaidForEpoch;
    // Track which epochs were ever credited so the invariant can iterate them.
    uint256[] public creditedEpochs;
    mapping(uint256 => bool) internal seenEpoch;

    uint256 public credits;
    uint256 public claims;
    uint256 public epochAdvances;

    constructor(UnifiedSharesLedger ledger_, FixtureERC20 prana_, uint256 epochLength_, uint256 issuance_) {
        ledger = ledger_;
        prana = prana_;
        epochLength = epochLength_;
        issuance = issuance_;

        for (uint256 i = 0; i < 5; i++) {
            actors.push(address(uint160(uint256(keccak256(abi.encode("usl.actor", i))))));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function creditedEpochCount() external view returns (uint256) {
        return creditedEpochs.length;
    }

    function _recordEpoch(uint256 e) internal {
        if (!seenEpoch[e]) {
            seenEpoch[e] = true;
            creditedEpochs.push(e);
        }
    }

    /// @notice Credit a bounded amount to a rotating actor + lane in the CURRENT epoch.
    function creditRandom(uint256 actorSeed, uint256 laneSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1, 10_000);
        IUnifiedSharesLedger.Lane lane = IUnifiedSharesLedger.Lane(laneSeed % 3);

        uint256 e = EpochManager.epochAt(block.timestamp, epochLength);

        // The ledger applies lane weight 1e18 (1x) for every lane in this fixture, so pooled==amount.
        ledger.creditShares(actor, lane, amount);

        ghostPooled[e] += amount;
        _recordEpoch(e);
        credits++;
    }

    /// @notice Warp forward 1..6 epochs (closes the current + intervening epochs).
    function advanceEpochs(uint256 n) external {
        n = bound(n, 1, 6);
        vm.warp(block.timestamp + n * epochLength);
        epochAdvances++;
    }

    /// @notice A rotating actor claims a rotating CLOSED epoch (skips open / already-claimed).
    function claimRandom(uint256 actorSeed, uint256 epochSeed) external {
        if (creditedEpochs.length == 0) return;
        address actor = actors[actorSeed % actors.length];
        uint256 e = creditedEpochs[epochSeed % creditedEpochs.length];

        if (!EpochManager.isEpochClosed(e, epochLength)) return;
        if (ledger.claimed(e, actor)) return;

        // Pre-compute the would-be payout; if the budget can't cover it the claim reverts and we
        // skip (the test funds generously, so this should not normally trigger).
        uint256 expected = ledger.claimable(actor, e);
        if (expected > ledger.totalFunded() - ledger.totalPaid()) return;

        vm.prank(actor);
        uint256 paid = ledger.claim(e);

        ghostPaidForEpoch[e] += paid;
        claims++;
    }
}

/// @title UnifiedSharesLedgerInvariant — stateful invariant suite for the PPLNS shares pool.
/// @notice Asserts the two headline invariants from the task: per-epoch CONSERVATION
///         (Σ payouts for any epoch never exceeds epochIssuance, dust rounds DOWN) and
///         GLOBAL BUDGET (totalPaid <= totalFunded), plus token-balance soundness.
contract UnifiedSharesLedgerInvariant is StdInvariant, Test {
    uint256 internal constant EPOCH_LEN = 3600;
    uint256 internal constant WINDOW = 3;
    uint256 internal constant ISSUANCE = 1000 ether;
    uint256 internal constant FUNDING = 100_000_000 ether;

    FixtureERC20 internal prana;
    HashTaskWeightConfig internal cfg;
    UnifiedSharesLedger internal ledger;
    USLHandler internal handler;

    function setUp() public {
        address admin = address(this);

        prana = new FixtureERC20("Prana", "PRANA", 18);

        // burnWeight 1e18 so HASH/TASK/BURN all pool at 1x (pure pro-rata; pooled == credited).
        cfg = new HashTaskWeightConfig(admin, 1e18, 1, 1_000_000);

        ledger = new UnifiedSharesLedger(prana, cfg, admin, EPOCH_LEN, WINDOW, ISSUANCE);

        handler = new USLHandler(ledger, prana, EPOCH_LEN, ISSUANCE);

        // The handler is the sole creditor for every lane (it credits on its own behalf).
        ledger.grantRole(ledger.HASH_CREDITOR(), address(handler));
        ledger.grantRole(ledger.TASK_CREDITOR(), address(handler));
        ledger.grantRole(ledger.BURN_CREDITOR(), address(handler));

        // Fund the budget generously so InsufficientFunds never masks a real invariant break.
        ledger.grantRole(ledger.FUNDER_ROLE(), admin);
        prana.mint(admin, FUNDING);
        prana.approve(address(ledger), type(uint256).max);
        ledger.fundEpoch(FUNDING);

        // Restrict fuzzing to the handler's bounded entrypoints.
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](3);
        sels[0] = handler.creditRandom.selector;
        sels[1] = handler.advanceEpochs.selector;
        sels[2] = handler.claimRandom.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// CORE BUDGET: never pay out more than was funded.
    function invariant_totalPaidNeverExceedsFunded() public view {
        assertLe(ledger.totalPaid(), ledger.totalFunded(), "totalPaid > totalFunded");
    }

    /// CORE CONSERVATION: for every epoch ever credited, the PRANA paid out for that epoch never
    /// exceeds the fixed per-epoch issuance (rounding only ever loses dust DOWNWARD).
    function invariant_perEpochConservation() public view {
        uint256 n = handler.creditedEpochCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 e = handler.creditedEpochs(i);
            assertLe(handler.ghostPaidForEpoch(e), ISSUANCE, "epoch payout exceeded issuance");
        }
    }

    /// SOUNDNESS: the ledger's remaining PRANA balance equals what it still owes (funded - paid),
    /// i.e. tokens only ever leave via accounted claims — no leak, no double-spend.
    function invariant_balanceMatchesUnpaidBudget() public view {
        assertEq(
            prana.balanceOf(address(ledger)),
            ledger.totalFunded() - ledger.totalPaid(),
            "ledger balance != unpaid budget"
        );
    }

    /// GHOST PARITY: the contract's totalPaid equals the sum of all per-epoch ghost payouts the
    /// handler recorded (the contract has no hidden payout path).
    function invariant_totalPaidMatchesGhostSum() public view {
        uint256 n = handler.creditedEpochCount();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            uint256 e = handler.creditedEpochs(i);
            sum += handler.ghostPaidForEpoch(e);
        }
        assertEq(ledger.totalPaid(), sum, "totalPaid != sum of ghost per-epoch payouts");
    }

    /// CREDIT PARITY: pooled shares the contract recorded for each epoch equal the ghost (weight 1x),
    /// confirming the credit path is the only way shares enter the pool.
    function invariant_pooledSharesMatchGhost() public view {
        uint256 n = handler.creditedEpochCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 e = handler.creditedEpochs(i);
            assertEq(ledger.totalPoolShares(e), handler.ghostPooled(e), "pooled shares != ghost");
        }
    }
}
