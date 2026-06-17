// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakedPRANA} from "../contracts/StakedPRANA.sol";
import {HathorFloorDistributor} from "../contracts/HathorFloorDistributor.sol";

contract StakedPRANATest is Test {
    StakedPRANA sp;
    address alice = address(0xA11CE);

    function setUp() public {
        sp = new StakedPRANA();
        vm.deal(alice, 100 ether);
    }

    function testStakeMintsAndSelfDelegates() public {
        vm.prank(alice);
        sp.stake{value: 10 ether}();
        assertEq(sp.balanceOf(alice), 10 ether);
        // auto self-delegated → vote weight active immediately
        assertEq(sp.delegates(alice), alice);
        assertEq(sp.getVotes(alice), 10 ether);
    }

    function testWithdrawBurnsVoteWeightImmediately_ClaimAfter30Days() public {
        vm.startPrank(alice);
        sp.stake{value: 10 ether}();
        sp.requestWithdraw(4 ether);
        // sPRANA burned now → vote weight drops immediately (no vote-then-dump)
        assertEq(sp.balanceOf(alice), 6 ether);
        assertEq(sp.getVotes(alice), 6 ether);
        assertEq(sp.unbondingTotal(), 4 ether);
        assertEq(sp.claimableOf(alice), 0);

        // cannot claim before cooldown
        vm.expectRevert(StakedPRANA.NothingClaimable.selector);
        sp.claim();

        vm.warp(block.timestamp + 30 days);
        assertEq(sp.claimableOf(alice), 4 ether);
        uint256 balBefore = alice.balance;
        sp.claim();
        assertEq(alice.balance, balBefore + 4 ether);
        assertEq(sp.unbondingTotal(), 0);
        vm.stopPrank();
    }

    function testCannotWithdrawMoreThanStaked() public {
        vm.startPrank(alice);
        sp.stake{value: 1 ether}();
        vm.expectRevert(StakedPRANA.InsufficientStake.selector);
        sp.requestWithdraw(2 ether);
        vm.stopPrank();
    }
}

contract HathorFloorDistributorTest is Test {
    HathorFloorDistributor dist;
    address timelock = address(0xDA0);
    address hathor = address(0xC0FFEE);
    address daoFund = address(0xF00D);

    function setUp() public {
        dist = new HathorFloorDistributor(timelock, hathor, daoFund);
    }

    function testDefaultsToThreePercentFloor() public view {
        assertEq(dist.hathorBps(), 300);
        (uint256 toH, uint256 toD) = dist.previewSplit(100 ether);
        assertEq(toH, 3 ether);
        assertEq(toD, 97 ether);
    }

    function testDistributeSplitsByShare() public {
        vm.deal(address(dist), 100 ether);
        dist.distribute();
        assertEq(hathor.balance, 3 ether);
        assertEq(daoFund.balance, 97 ether);
    }

    function testDaoCanRaiseHathorShareUpTo100() public {
        vm.prank(timelock);
        dist.setHathorShare(10_000); // 100% to Hathor — allowed
        vm.deal(address(dist), 50 ether);
        dist.distribute();
        assertEq(hathor.balance, 50 ether);
        assertEq(daoFund.balance, 0);
    }

    function testCannotCutBelowThreePercentFloor() public {
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(HathorFloorDistributor.BelowHathorFloor.selector, uint256(299)));
        dist.setHathorShare(299);
        vm.expectRevert(abi.encodeWithSelector(HathorFloorDistributor.BelowHathorFloor.selector, uint256(0)));
        dist.setHathorShare(0);
        vm.stopPrank();
    }

    function testOnlyOwnerGovernsShare() public {
        vm.expectRevert();
        dist.setHathorShare(500); // non-owner
    }
}
