// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BurnMine} from "../../contracts/BurnMine.sol";
import {FixtureERC20, FixtureMintableERC20} from "../helpers/Fixtures.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

/// @title BurnMineHandler — bounded random driver for BurnMine.mine().
/// @notice The invariant fuzzer calls `mine(...)` here with bounded amounts and rotating actors.
///         It tracks the same off-chain expectations the mocha invariant test tracks so the
///         invariant assertions can be checked against an independent accumulator.
contract BurnMineHandler is Test {
    BurnMine public immutable mine;
    FixtureERC20 public immutable input;
    FixtureMintableERC20 public immutable output;
    uint256 public immutable ratioNum;
    uint256 public immutable ratioDen;

    // Independent ghost accumulators (mirror the JS invariant's expectedBurned/expectedMinted).
    uint256 public ghostBurned;
    uint256 public ghostMinted;
    uint256 public mineCalls;
    uint256 public skippedZeroOut;

    address[] internal actors;

    constructor(BurnMine mine_, FixtureERC20 input_, FixtureMintableERC20 output_, uint256 num_, uint256 den_) {
        mine = mine_;
        input = input_;
        output = output_;
        ratioNum = num_;
        ratioDen = den_;

        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("bm.actor", i)))));
            actors.push(a);
            input.mint(a, 10_000_000 ether);
            vm.prank(a);
            input.approve(address(mine), type(uint256).max);
        }
    }

    /// @notice Fuzz entrypoint: a bounded burn by a rotating actor.
    function mineSome(uint256 actorSeed, uint256 amountIn) external {
        address actor = actors[actorSeed % actors.length];
        amountIn = bound(amountIn, 1, 5_000 ether);

        uint256 expectedOut = (amountIn * ratioNum) / ratioDen;
        if (expectedOut == 0) {
            // Contract rejects rounds-to-zero; record and skip without touching ghosts.
            skippedZeroOut++;
            return;
        }
        // Cap to the actor's balance so transfers don't revert and stall the run.
        uint256 bal = input.balanceOf(actor);
        if (amountIn > bal) return;

        vm.prank(actor);
        uint256 out = mine.mine(amountIn);

        ghostBurned += amountIn;
        ghostMinted += out;
        mineCalls++;
    }
}

/// @title BurnMineInvariant — stateful invariant suite mirroring the mocha invariants.
contract BurnMineInvariant is StdInvariant, Test {
    uint256 internal constant RATIO_NUM = 3;
    uint256 internal constant RATIO_DEN = 7; // non-divisible: forces floor rounding

    FixtureERC20 internal input;
    FixtureMintableERC20 internal output;
    BurnMine internal mine;
    BurnMineHandler internal handler;

    function setUp() public {
        address admin = address(this);
        input = new FixtureERC20("Input", "IN", 18);
        output = new FixtureMintableERC20("Proof of Liquidity", "POL", admin);

        mine = new BurnMine(input, output, RATIO_NUM, RATIO_DEN);
        output.grantRole(output.MINTER_ROLE(), address(mine));

        handler = new BurnMineHandler(mine, input, output, RATIO_NUM, RATIO_DEN);

        // Restrict fuzzing to the handler's bounded entrypoint.
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = handler.mineSome.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// CORE: cumulative minted is the floored ratio of burned, hence minted*den <= burned*num.
    function invariant_conservation() public view {
        assertLe(mine.totalMinted() * RATIO_DEN, mine.totalBurned() * RATIO_NUM, "minted exceeds ratio * burned");
    }

    /// Contract counters must equal the independent ghost accumulators (no hidden mint/burn path).
    function invariant_counters_match_ghosts() public view {
        assertEq(mine.totalBurned(), handler.ghostBurned(), "burned != ghost");
        assertEq(mine.totalMinted(), handler.ghostMinted(), "minted != ghost");
    }

    /// Output total supply equals everything ever minted (mine is the only minter exercised).
    function invariant_output_supply_equals_minted() public view {
        assertEq(output.totalSupply(), mine.totalMinted(), "output supply != totalMinted");
        // And supply can never exceed the floored ratio of all burns.
        assertLe(output.totalSupply(), (mine.totalBurned() * RATIO_NUM) / RATIO_DEN, "supply > maxAllowed");
    }

    /// True sink: the mine never stockpiles the input token.
    function invariant_mine_holds_no_input() public view {
        assertEq(input.balanceOf(address(mine)), 0, "mine stockpiled input");
    }

    function invariant_callSummary() public view {
        // Visible in -vvv runs; not an assertion.
        console2log();
    }

    function console2log() internal view {
        // no-op placeholder to keep an explicit summary hook without importing console in prod path
        handler.mineCalls();
    }
}
