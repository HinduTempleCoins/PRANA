// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PotDistributor} from "../src/PotDistributor.sol";
import {PotBase, MerkleLib} from "./PotDistributor.t.sol";

/// Handler drives random consensus credits, signed rounds (honest AND over-allocating), vetoes,
/// pauses, finalizations and claims (valid, inflated, replayed) against one PotDistributor.
contract PotHandler is Test {
    PotDistributor public pd;
    uint256[] sk;
    address guardian;
    uint64 ch;
    address[] public actors;

    // ghost state
    uint256 public ghostReceived;
    uint256 public ghostPaidOut;
    mapping(address => uint256) public lastCum; // cumulative in the ACTIVE root
    mapping(address => uint256) public pendCum;
    uint256[] curCum; // cumulative per actor of the latest built tree
    bytes32[] pendLeaves;
    bytes32[] actLeaves;
    uint256[] actCum; // leaf cumulative (may be over-allocated) — used for proofs
    uint256[] actBase; // honest cumulative base used to build the next declared total
    mapping(address => uint256) public pendBase;

    constructor(PotDistributor pd_, uint256[] memory sk_, address guardian_, uint64 ch_) {
        pd = pd_;
        sk = sk_;
        guardian = guardian_;
        ch = ch_;
        for (uint256 i = 0; i < 6; ++i) {
            actors.push(address(uint160(0xA000 + i)));
            curCum.push(0);
        }
    }

    function creditPot(uint96 x) external {
        x = uint96(bound(x, 0, 1000 ether));
        vm.deal(address(pd), address(pd).balance + x);
        ghostReceived += x;
    }

    /// signed round: grows each actor's cumulative by a random share of unallocated value.
    /// `overAllocate` makes leaves sum above the declared total (colluding/buggy signers).
    function postRound(uint256 seed, bool overAllocate) external {
        (bytes32 pr,,,,) = pd.pending();
        if (pr != bytes32(0)) return;
        (, uint256 activeTotal,, uint64 activeEnd,) = pd.active();
        uint256 received = pd.receivedTotal();
        if (received <= activeTotal) return;
        uint256 room = received - activeTotal;
        uint256[] memory nc = new uint256[](actors.length);
        bytes32[] memory leaves = new bytes32[](actors.length);
        uint256 total;
        for (uint256 i = 0; i < actors.length; ++i) {
            uint256 add = (room / actors.length) * (uint256(keccak256(abi.encode(seed, i))) % 100) / 100;
            uint256 base = (actBase.length > i ? actBase[i] : 0) + add;
            nc[i] = overAllocate ? base + room : base; // over-allocation: leaves exceed the declared total
            total += base;
            pendBase[actors[i]] = base;
            leaves[i] = pd.leaf(actors[i], nc[i]);
        }
        bytes32 root = MerkleLib.root(leaves);
        uint64 round = pd.currentRound() + 1;
        vm.roll(block.number + 2);
        uint64 eb = uint64(block.number - 1);
        if (eb <= activeEnd) return;
        bytes[] memory s = new bytes[](2);
        s[0] = _sig(sk[0], round, root, total, eb);
        s[1] = _sig(sk[1], round, root, total, eb);
        pd.postRoot(round, root, total, keccak256("i"), eb, s);
        delete pendLeaves;
        for (uint256 i = 0; i < actors.length; ++i) {
            pendLeaves.push(leaves[i]);
            pendCum[actors[i]] = nc[i];
        }
    }

    function _sig(uint256 key, uint64 round, bytes32 root, uint256 total, uint64 eb)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pd.rootDigest(round, root, total, keccak256("i"), eb));
        return abi.encodePacked(r, s, v);
    }

    function warpAndFinalize(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 * ch));
        (bytes32 pr,,,,) = pd.pending();
        if (pr == bytes32(0) || pd.paused()) return;
        if (block.timestamp < pd.pendingClaimableAt()) return;
        pd.finalize();
        _adopt();
    }

    function _adopt() internal {
        delete actLeaves;
        delete actCum;
        delete actBase;
        for (uint256 i = 0; i < actors.length; ++i) {
            actLeaves.push(pendLeaves[i]);
            actCum.push(pendCum[actors[i]]);
            actBase.push(pendBase[actors[i]]);
            // per-account cap = the highest cumulative this account was ever offered by an ACTIVE root (a later
            // over-allocating-then-corrected root may offer less; the contract then just pays nothing more)
            if (pendCum[actors[i]] > lastCum[actors[i]]) lastCum[actors[i]] = pendCum[actors[i]];
        }
    }

    function veto() external {
        (bytes32 pr,,,,) = pd.pending();
        if (pr == bytes32(0)) return;
        uint64 r = pd.pendingRound();
        vm.prank(guardian);
        pd.veto(r);
    }

    function togglePause(bool on) external {
        vm.prank(guardian);
        if (on) pd.pause();
        else pd.unpause();
    }

    function claim(uint256 who, uint256 inflate) external {
        if (actLeaves.length == 0 || pd.paused()) return;
        who = who % actors.length;
        inflate = bound(inflate, 0, 3);
        address a = actors[who];
        uint256 c = actCum[who] + inflate; // inflate > 0 must fail (InvalidProof)
        bytes32[] memory p = MerkleLib.proof(actLeaves, who);
        uint256 before = a.balance;
        try pd.claim(a, c, p) {
            assertEq(inflate, 0, "inflated claim succeeded");
            ghostPaidOut += a.balance - before;
        } catch {}
    }
}

contract PotInvariantTest is PotBase {
    PotHandler h;

    function setUp() public override {
        super.setUp();
        h = new PotHandler(pd, sk, guardian, CH);
        targetContract(address(h));
    }

    /// value conservation: everything received is either still held or was paid out by a claim
    function invariant_conservation() public view {
        assertEq(address(pd).balance + pd.totalClaimed(), h.ghostReceived());
        assertEq(pd.totalClaimed(), h.ghostPaidOut());
    }

    /// solvency: payouts never exceed the active root's declared total, which never exceeds receipts
    function invariant_solvency() public view {
        (, uint256 activeTotal,,,) = pd.active();
        assertLe(pd.totalClaimed(), activeTotal);
        assertLe(activeTotal, pd.receivedTotal());
        (bytes32 pr, uint256 pendTotal,,,) = pd.pending();
        if (pr != bytes32(0)) assertLe(pendTotal, pd.receivedTotal());
    }

    /// no account ever got more than its cumulative in the active root
    function invariant_per_account_cap() public view {
        for (uint256 i = 0; i < 6; ++i) {
            address a = h.actors(i);
            assertLe(pd.claimed(a), h.lastCum(a));
            assertEq(a.balance, pd.claimed(a));
        }
    }
}
