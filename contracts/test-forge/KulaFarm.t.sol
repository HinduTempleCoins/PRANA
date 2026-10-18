// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {KULA} from "../contracts/KULA.sol";
import {PoLToken} from "../contracts/PoLToken.sol";
import {MultiBurnMine, IKulaMint} from "../contracts/MultiBurnMine.sol";
import {BurnMineHub} from "../contracts/BurnMineHub.sol";
import {BurnMine, IMintable} from "../contracts/BurnMine.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

contract KulaFarmTest is Test {
    KULA kula;
    PoLToken pol;
    MultiBurnMine mine;
    address admin = address(this);
    address user;
    address miner;
    uint256 cap = 1_000_000 ether;

    function setUp() public {
        user = makeAddr("user");
        miner = makeAddr("miner");
        kula = new KULA(cap, 0, admin, admin);
        kula.grantRole(kula.MINTER_ROLE(), admin); // test-only: exercise direct mint/cap/pause paths
        pol = new PoLToken(admin);
        mine = new MultiBurnMine(IKulaMint(address(kula)), admin);
        kula.grantRole(kula.MINTER_ROLE(), address(mine));
        mine.setInput(address(pol), 2, 1, true, true);   // 1 PoL burned -> 2 KULA
        pol.mint(user, 1000 ether);
    }

    // ── KULA token ────────────────────────────────────────────────────────────────────────────────
    function test_mint_is_role_gated() public {
        vm.prank(user);
        vm.expectRevert();           // user has no MINTER_ROLE
        kula.mint(user, 1 ether);
    }

    function test_cap_enforced() public {
        kula.mint(admin, cap);       // admin is a minter; fill to the cap
        vm.expectRevert();           // one more wei exceeds the cap
        kula.mint(admin, 1);
    }

    function test_pause_blocks_transfers() public {
        kula.mint(admin, 10 ether);
        kula.pause();
        vm.expectRevert();
        kula.transfer(user, 1 ether);
        kula.unpause();
        kula.transfer(user, 1 ether);   // works again
        assertEq(kula.balanceOf(user), 1 ether);
    }

    // ── MultiBurnMine: burn PoL -> mint KULA at the ratio ──────────────────────────────────────────
    function test_burn_pol_mints_kula_at_ratio() public {
        vm.startPrank(user);
        pol.approve(address(mine), 100 ether);
        uint256 out = mine.mine(address(pol), 100 ether);
        vm.stopPrank();
        assertEq(out, 200 ether, "ratio 2:1");
        assertEq(kula.balanceOf(user), 200 ether);
        assertEq(pol.balanceOf(user), 900 ether, "100 PoL pulled");
        assertEq(pol.totalSupply(), 900 ether, "100 PoL truly burned (supply down)");
        assertEq(mine.totalMinedFrom(address(pol)), 200 ether);
    }

    function test_disabled_input_reverts() public {
        mine.setInput(address(pol), 2, 1, true, false);   // disable
        vm.startPrank(user);
        pol.approve(address(mine), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(MultiBurnMine.NotEnabled.selector, address(pol)));
        mine.mine(address(pol), 1 ether);
        vm.stopPrank();
    }

    function test_setInput_is_admin_only() public {
        vm.prank(user);
        vm.expectRevert();
        mine.setInput(address(pol), 1, 1, true, true);
    }

    function test_pause_blocks_mining() public {
        mine.pause();
        vm.startPrank(user);
        pol.approve(address(mine), 1 ether);
        vm.expectRevert();
        mine.mine(address(pol), 1 ether);
        vm.stopPrank();
    }

    // ── miners + lotto get KULA (granted MINTER_ROLE) ──────────────────────────────────────────────
    function test_granted_emitter_can_mint() public {
        kula.grantRole(kula.MINTER_ROLE(), miner);   // PRANA miner creditor / lotto
        vm.prank(miner);
        kula.mint(user, 5 ether);
        assertEq(kula.balanceOf(user), 5 ether, "a granted emitter (miners/lotto) can mint KULA");
    }

    // ── BurnMineHub: the "place" deploys + hosts burn contracts that mint KULA AND other tokens ─────
    function test_hub_deploys_and_hosts_a_mine_minting_kula() public {
        BurnMineHub hub = new BurnMineHub(admin);
        (BurnMine m, uint256 id) =
            hub.deployBurnMine(ERC20Burnable(address(pol)), IMintable(address(kula)), 1, 1, "Burn PoL -> KULA");
        // the output token's admin grants the new mine MINTER_ROLE (the hub can't grant what it doesn't own)
        kula.grantRole(kula.MINTER_ROLE(), address(m));
        assertEq(hub.mineCount(), 1);
        assertTrue(hub.isHosted(address(m)));
        // and it actually burns→mints
        pol.mint(user, 10 ether);
        vm.startPrank(user);
        pol.approve(address(m), 10 ether);
        m.mine(10 ether);
        vm.stopPrank();
        assertEq(kula.balanceOf(user), 10 ether);
        BurnMineHub.Mine[] memory active = hub.activeMines();
        assertEq(active.length, 1);
        assertEq(active[0].output, address(kula), "hub records the output token (here KULA; could be another)");
        id; // silence unused
    }

    function test_hub_curator_gated_and_setActive_hides() public {
        BurnMineHub hub = new BurnMineHub(admin);
        vm.prank(user);
        vm.expectRevert();   // user is not a curator
        hub.deployBurnMine(ERC20Burnable(address(pol)), IMintable(address(kula)), 1, 1, "x");
        (, uint256 id) = hub.deployBurnMine(ERC20Burnable(address(pol)), IMintable(address(kula)), 1, 1, "x");
        hub.setActive(id, false);
        assertEq(hub.activeMines().length, 0, "hidden from the page when inactive");
    }
}
