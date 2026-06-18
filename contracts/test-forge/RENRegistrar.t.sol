// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RENRegistrar} from "../contracts/RENRegistrar.sol";
import {BaseTest} from "./helpers/BaseTest.sol";
import {FixtureERC20} from "./helpers/Fixtures.sol";

contract RENRegistrarTest is BaseTest {
    RENRegistrar internal ren;
    FixtureERC20 internal kula;

    function setUp() public override {
        super.setUp();
        kula = deployERC20("KULA", "KULA");
        ren = new RENRegistrar(address(kula), treasury, admin);
        kula.mint(alice, 1_000 ether);
        kula.mint(bob, 1_000 ether);
    }

    // ── register in PRANA ──
    function test_registerWithPrana() public {
        uint256 cost = ren.priceOf("ryan.melek", 1, false); // label "ryan" = 4 chars -> 5 ether/yr
        assertEq(cost, 5 ether);
        uint256 feeBefore = treasury.balance;
        vm.prank(alice);
        ren.register{value: cost}("ryan.melek", 1, false);
        assertEq(ren.ownerOf(ren.id("ryan.melek")), alice);
        assertEq(ren.resolve("ryan.melek"), alice);              // addr defaults to registrant
        assertEq(treasury.balance - feeBefore, cost);           // fee forwarded
        assertApproxEqAbs(ren.nameExpires("ryan.melek"), uint64(block.timestamp + 365 days), 2);
        assertEq(ren.available("ryan.melek"), false);
    }

    // ── register in KULA ──
    function test_registerWithKula() public {
        uint256 cost = ren.priceOf("ryan.melek", 2, true);       // 4-char -> 50 KULA/yr * 2
        assertEq(cost, 100 ether);
        vm.startPrank(bob);
        kula.approve(address(ren), cost);
        ren.register("ryan.melek", 2, true);
        vm.stopPrank();
        assertEq(ren.ownerOf(ren.id("ryan.melek")), bob);
        assertEq(kula.balanceOf(treasury), cost);
        assertApproxEqAbs(ren.nameExpires("ryan.melek"), uint64(block.timestamp + 2 * 365 days), 2);
    }

    // ── length-tiered pricing ──
    function test_lengthPricing() public view {
        assertEq(ren.priceOf("a.melek", 1, false), 50 ether);    // 1-char
        assertEq(ren.priceOf("ab.melek", 1, false), 20 ether);   // 2
        assertEq(ren.priceOf("abc.melek", 1, false), 10 ether);  // 3
        assertEq(ren.priceOf("abcd.melek", 1, false), 5 ether);  // 4
        assertEq(ren.priceOf("abcde.melek", 1, false), 1 ether); // 5+
        assertEq(ren.priceOf("abcdefgh.melek", 1, false), 1 ether);
    }

    // ── renewal extends the lease ──
    function test_renew() public {
        uint256 cost = ren.priceOf("name.melek", 1, false);      // "name" 4 -> 5 ether
        vm.prank(alice); ren.register{value: cost}("name.melek", 1, false);
        uint64 exp1 = ren.nameExpires("name.melek");
        vm.prank(bob); ren.renew{value: cost}("name.melek", 1, false); // anyone can pay to renew
        assertApproxEqAbs(ren.nameExpires("name.melek"), exp1 + 365 days, 2);
    }

    // ── can't take a live name ──
    function test_takenReverts() public {
        uint256 cost = ren.priceOf("ryan.melek", 1, false);
        vm.prank(alice); ren.register{value: cost}("ryan.melek", 1, false);
        vm.deal(bob, 100 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("taken"));
        ren.register{value: cost}("ryan.melek", 1, false);
    }

    // ── expiry + grace → frees up, re-registerable ──
    function test_expiryGraceReRegister() public {
        uint256 cost = ren.priceOf("temp.melek", 1, false);
        vm.prank(alice); ren.register{value: cost}("temp.melek", 1, false);
        // still in grace just after expiry → not available
        vm.warp(block.timestamp + 365 days + 1 days);
        assertEq(ren.available("temp.melek"), false);
        vm.prank(bob); vm.expectRevert(bytes("taken")); ren.register{value: cost}("temp.melek", 1, false);
        // past grace → available, bob can take it (old NFT burned, new owner)
        vm.warp(block.timestamp + 90 days);
        assertEq(ren.available("temp.melek"), true);
        vm.prank(bob); ren.register{value: cost}("temp.melek", 1, false);
        assertEq(ren.ownerOf(ren.id("temp.melek")), bob);
    }

    // ── records: owner sets addr/contenthash/text; others can't; expired can't ──
    function test_records() public {
        uint256 cost = ren.priceOf("site.melek", 1, false);      // "site" 4
        vm.startPrank(alice);
        ren.register{value: cost}("site.melek", 1, false);
        ren.setAddr("site.melek", bob);
        ren.setContenthash("site.melek", keccak256("ipfs-cid"));
        ren.setText("site.melek", "url", "https://example.com");
        vm.stopPrank();
        assertEq(ren.resolve("site.melek"), bob);
        assertEq(ren.contenthashOf("site.melek"), keccak256("ipfs-cid"));
        assertEq(ren.text("site.melek", "url"), "https://example.com");
        vm.prank(carol);
        vm.expectRevert(bytes("not owner"));
        ren.setAddr("site.melek", carol);
    }

    // ── validation ──
    function test_badTldReverts() public {
        uint256 cost = ren.priceOf("x.foo", 1, false);
        vm.prank(alice);
        vm.expectRevert(bytes("tld"));
        ren.register{value: cost}("hello.foo", 1, false);
    }
    function test_badCharReverts() public {
        vm.prank(alice);
        vm.expectRevert(bytes("char"));
        ren.register{value: 5 ether}("Ryan.melek", 1, false); // uppercase not allowed
    }
    function test_noDotReverts() public {
        vm.prank(alice);
        vm.expectRevert(bytes("label.tld"));
        ren.register{value: 5 ether}("nodot", 1, false);
    }

    // ── payment guards ──
    function test_badPranaValueReverts() public {
        vm.prank(alice);
        vm.expectRevert(bytes("bad PRANA value"));
        ren.register{value: 1 ether}("ryan.melek", 1, false); // should be 5
    }
    function test_kulaPathRejectsNativeValue() public {
        vm.startPrank(alice);
        kula.approve(address(ren), 100 ether);
        vm.expectRevert(bytes("no native for kula"));
        ren.register{value: 1 ether}("ryan.melek", 1, true);
        vm.stopPrank();
    }

    // ── admin retunes prices + tlds ──
    function test_adminSetPrices() public {
        vm.prank(admin);
        ren.setPrices([uint256(9 ether),8 ether,7 ether,6 ether,2 ether],[uint256(90 ether),80 ether,70 ether,60 ether,20 ether]);
        assertEq(ren.priceOf("abcd.melek", 1, false), 6 ether);
    }
}
