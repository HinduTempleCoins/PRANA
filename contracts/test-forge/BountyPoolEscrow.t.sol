// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyPoolEscrow} from "../contracts/BountyPoolEscrow.sol";

contract Tok is ERC20 {
    constructor() ERC20("T", "T") { _mint(msg.sender, 1e30); }
}

/// takes a 1% fee on every transfer
contract FeeTok is ERC20 {
    constructor() ERC20("F", "F") { _mint(msg.sender, 1e30); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) { super._update(from, address(0xdead), v / 100); v -= v / 100; }
        super._update(from, to, v);
    }
}

contract BountyPoolEscrowTest is Test {
    BountyPoolEscrow esc;
    Tok tok;
    address admin = address(0xA11CE);
    address sponsor = address(0x5905);
    address worker = address(0xB0B);
    address attacker = address(0xBAD);

    function setUp() public {
        esc = new BountyPoolEscrow(admin);
        tok = new Tok();
        tok.transfer(sponsor, 1e24);
        vm.prank(sponsor);
        tok.approve(address(esc), type(uint256).max);
    }

    function _pool(uint128 r, uint32 s) internal returns (uint256 id) {
        vm.prank(sponsor);
        id = esc.createPool(IERC20(address(tok)), r, s, uint64(block.timestamp + 7 days), keccak256("pool"));
    }

    function test_create_pulls_full_pot() public {
        uint256 id = _pool(10e18, 5);
        assertEq(tok.balanceOf(address(esc)), 50e18);
        (,,, uint32 slots,,, uint256 bal) = esc.pools(id);
        assertEq(slots, 5); assertEq(bal, 50e18);
    }

    function test_release_pays_once_per_task_and_counts_slots() public {
        uint256 id = _pool(10e18, 2);
        vm.prank(admin); esc.release(id, worker, keccak256("t1"));
        assertEq(tok.balanceOf(worker), 10e18);
        vm.prank(admin); vm.expectRevert("task already paid"); esc.release(id, worker, keccak256("t1"));
        vm.prank(admin); esc.release(id, worker, keccak256("t2"));
        vm.prank(admin); vm.expectRevert("no slots left"); esc.release(id, worker, keccak256("t3"));
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    function test_only_attestor_releases() public {
        uint256 id = _pool(10e18, 1);
        vm.prank(attacker); vm.expectRevert(); esc.release(id, attacker, keccak256("x"));
        vm.prank(sponsor); vm.expectRevert(); esc.release(id, sponsor, keccak256("x"));
    }

    function test_sponsor_cannot_reclaim_while_open() public {
        uint256 id = _pool(10e18, 3);
        vm.prank(sponsor); vm.expectRevert("pool still open"); esc.reclaim(id);
    }

    function test_reclaim_after_deadline_returns_only_the_rest() public {
        uint256 id = _pool(10e18, 3);
        vm.prank(admin); esc.release(id, worker, keccak256("t1"));
        vm.warp(block.timestamp + 8 days);
        vm.prank(admin); vm.expectRevert("pool closed"); esc.release(id, worker, keccak256("t2"));
        uint256 before = tok.balanceOf(sponsor);
        vm.prank(attacker); vm.expectRevert("not sponsor"); esc.reclaim(id);
        vm.prank(sponsor); esc.reclaim(id);
        assertEq(tok.balanceOf(sponsor) - before, 20e18);
        vm.prank(sponsor); vm.expectRevert("nothing left"); esc.reclaim(id);
    }

    function test_pools_are_separate_across_tokens() public {
        Tok other = new Tok();
        other.transfer(sponsor, 1e24);
        vm.startPrank(sponsor);
        other.approve(address(esc), type(uint256).max);
        uint256 a = esc.createPool(IERC20(address(tok)), 1e18, 1, uint64(block.timestamp + 2 days), bytes32(0));
        uint256 b = esc.createPool(IERC20(address(other)), 5e18, 1, uint64(block.timestamp + 2 days), bytes32(0));
        vm.stopPrank();
        vm.prank(admin); esc.release(b, worker, keccak256("x"));
        assertEq(other.balanceOf(worker), 5e18); assertEq(tok.balanceOf(worker), 0);
        vm.prank(admin); esc.release(a, worker, keccak256("x"));
        assertEq(tok.balanceOf(worker), 1e18);
    }

    function test_rejects_fee_on_transfer_and_bad_params() public {
        FeeTok f = new FeeTok();
        f.transfer(sponsor, 1e24);
        vm.startPrank(sponsor);
        f.approve(address(esc), type(uint256).max);
        vm.expectRevert("fee-on-transfer token"); esc.createPool(IERC20(address(f)), 1e18, 1, uint64(block.timestamp + 2 days), bytes32(0));
        vm.expectRevert("deadline too soon"); esc.createPool(IERC20(address(tok)), 1e18, 1, uint64(block.timestamp + 1 hours), bytes32(0));
        vm.expectRevert("empty pool"); esc.createPool(IERC20(address(tok)), 0, 1, uint64(block.timestamp + 2 days), bytes32(0));
        vm.stopPrank();
    }

    function testFuzz_payouts_never_exceed_pot(uint8 n) public {
        uint32 slots = 10;
        uint256 id = _pool(3e18, slots);
        uint256 paid;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(admin);
            try esc.release(id, worker, bytes32(i)) { paid += 3e18; } catch {}
        }
        assertLe(paid, uint256(3e18) * slots);
        assertEq(tok.balanceOf(worker), paid);
        assertEq(tok.balanceOf(address(esc)), uint256(3e18) * slots - paid);
    }
}
