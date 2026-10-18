// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PotDistributor} from "../src/PotDistributor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Sorted-pair (commutative) Merkle tree identical to OZ MerkleProof / payout/merkle.py.
library MerkleLib {
    function hp(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory l = leaves;
        uint256 n = l.length;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            bytes32[] memory nx = new bytes32[](m);
            for (uint256 i = 0; i < n / 2; ++i) {
                nx[i] = hp(l[2 * i], l[2 * i + 1]);
            }
            if (n % 2 == 1) nx[m - 1] = l[n - 1];
            l = nx;
            n = m;
        }
        return l[0];
    }

    function proof(bytes32[] memory leaves, uint256 idx) internal pure returns (bytes32[] memory) {
        bytes32[] memory out = new bytes32[](32);
        uint256 k = 0;
        bytes32[] memory l = leaves;
        uint256 n = l.length;
        while (n > 1) {
            uint256 sib = idx ^ 1;
            if (sib < n) out[k++] = l[sib];
            uint256 m = (n + 1) / 2;
            bytes32[] memory nx = new bytes32[](m);
            for (uint256 i = 0; i < n / 2; ++i) {
                nx[i] = hp(l[2 * i], l[2 * i + 1]);
            }
            if (n % 2 == 1) nx[m - 1] = l[n - 1];
            l = nx;
            n = m;
            idx /= 2;
        }
        bytes32[] memory p = new bytes32[](k);
        for (uint256 i = 0; i < k; ++i) {
            p[i] = out[i];
        }
        return p;
    }
}

contract Reenterer {
    PotDistributor public pd;
    bytes32[] public proof;
    uint256 public cumulative;
    bool public swallow;
    uint256 public hits;

    constructor(PotDistributor pd_) {
        pd = pd_;
    }

    function arm(uint256 c, bytes32[] memory p, bool swallow_) external {
        cumulative = c;
        proof = p;
        swallow = swallow_;
    }

    function go() external {
        pd.claim(address(this), cumulative, proof);
    }

    receive() external payable {
        hits++;
        if (swallow) {
            try pd.claim(address(this), cumulative, proof) {} catch {}
        } else {
            pd.claim(address(this), cumulative, proof); // reverts (nonReentrant) -> bubbles -> TransferFailed
        }
    }
}

contract GasBurner {
    uint256 x;

    receive() external payable {
        while (true) {
            x++; // runs out of the forwarded PUSH_GAS -> call fails
        }
    }
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract PotBase is Test {
    PotDistributor pd;
    TimelockController tl;
    address guardian = makeAddr("guardian");
    address proposer = makeAddr("proposer");
    uint256[] sk; // signer private keys, sorted by address
    address[] sa; // signer addresses (sorted)
    uint64 constant CH = 6 hours;
    uint256 constant TL_DELAY = 2 days;

    function setUp() public virtual {
        // 3 signers, K=2
        uint256[3] memory keys = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC4A7)];
        for (uint256 i = 0; i < 3; ++i) {
            sk.push(keys[i]);
            sa.push(vm.addr(keys[i]));
        }
        _sortSigners();
        address[] memory props = new address[](1);
        props[0] = proposer;
        address[] memory execs = new address[](1);
        execs[0] = address(0); // anyone executes after delay
        tl = new TimelockController(TL_DELAY, props, execs, address(0));
        pd = new PotDistributor(address(tl), guardian, sa, 2, CH);
        vm.roll(100);
    }

    function _sortSigners() internal {
        for (uint256 i = 0; i < sa.length; ++i) {
            for (uint256 j = i + 1; j < sa.length; ++j) {
                if (sa[j] < sa[i]) {
                    (sa[i], sa[j]) = (sa[j], sa[i]);
                    (sk[i], sk[j]) = (sk[j], sk[i]);
                }
            }
        }
    }

    // consensus credit: AddBalance with no code execution == vm.deal
    function credit(uint256 x) internal {
        vm.deal(address(pd), address(pd).balance + x);
    }

    function sig(uint256 key, uint64 round, bytes32 r, uint256 total, bytes32 ih, uint64 eb)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = pd.rootDigest(round, r, total, ih, eb);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(key, d);
        return abi.encodePacked(rr, ss, v);
    }

    function sigs2(uint64 round, bytes32 r, uint256 total, bytes32 ih, uint64 eb)
        internal
        view
        returns (bytes[] memory s)
    {
        s = new bytes[](2);
        s[0] = sig(sk[0], round, r, total, ih, eb);
        s[1] = sig(sk[1], round, r, total, ih, eb);
    }

    struct Tree {
        address[] acct;
        uint256[] cum;
        bytes32[] leaves;
        bytes32 root;
        uint256 total;
    }

    function tree(address[] memory a, uint256[] memory c) internal view returns (Tree memory t) {
        t.acct = a;
        t.cum = c;
        t.leaves = new bytes32[](a.length);
        for (uint256 i = 0; i < a.length; ++i) {
            t.leaves[i] = pd.leaf(a[i], c[i]);
            t.total += c[i];
        }
        t.root = MerkleLib.root(t.leaves);
    }

    function post(Tree memory t) internal returns (uint64 round) {
        round = pd.currentRound() + 1;
        uint64 eb = uint64(block.number - 1);
        pd.postRoot(round, t.root, t.total, keccak256("inputs"), eb, sigs2(round, t.root, t.total, keccak256("inputs"), eb));
    }

    function postAndFinalize(Tree memory t) internal {
        post(t);
        vm.warp(block.timestamp + CH);
        vm.roll(block.number + 1);
        pd.finalize();
    }

    function prove(Tree memory t, uint256 i) internal pure returns (bytes32[] memory) {
        return MerkleLib.proof(t.leaves, i);
    }
}

contract PotDistributorTest is PotBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function three(uint256 a, uint256 b, uint256 c) internal view returns (Tree memory) {
        address[] memory ac = new address[](3);
        ac[0] = alice;
        ac[1] = bob;
        ac[2] = carol;
        uint256[] memory cu = new uint256[](3);
        cu[0] = a;
        cu[1] = b;
        cu[2] = c;
        return tree(ac, cu);
    }

    // ---------------------------------------------------------------- constructor / config
    function test_constructor_rejects_bad_sets() public {
        address[] memory two = new address[](2);
        two[0] = address(1);
        two[1] = address(2);
        vm.expectRevert(PotDistributor.BadSignerSet.selector);
        new PotDistributor(address(tl), guardian, two, 2, CH); // M < 3
        vm.expectRevert(PotDistributor.BadSignerSet.selector);
        new PotDistributor(address(tl), guardian, sa, 1, CH); // K < 2
        vm.expectRevert(PotDistributor.BadSignerSet.selector);
        new PotDistributor(address(tl), guardian, sa, 4, CH); // K > M
        address[] memory dup = new address[](3);
        dup[0] = address(1);
        dup[1] = address(2);
        dup[2] = address(1);
        vm.expectRevert(PotDistributor.BadSignerSet.selector);
        new PotDistributor(address(tl), guardian, dup, 2, CH);
        address[] memory z = new address[](3);
        z[0] = address(1);
        z[1] = address(2);
        vm.expectRevert(PotDistributor.BadSignerSet.selector);
        new PotDistributor(address(tl), guardian, z, 2, CH);
        vm.expectRevert(PotDistributor.BadChallengePeriod.selector);
        new PotDistributor(address(tl), guardian, sa, 2, 10 minutes);
        vm.expectRevert(PotDistributor.ZeroAddress.selector);
        new PotDistributor(address(0), guardian, sa, 2, CH);
    }

    function test_no_receive_plain_transfer_reverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(pd).call{value: 1 ether}("");
        assertFalse(ok);
        // but a consensus credit (AddBalance) is accounted
        credit(5 ether);
        assertEq(pd.receivedTotal(), 5 ether);
    }

    // ---------------------------------------------------------------- happy path
    function test_post_window_finalize_claim() public {
        credit(10 ether);
        Tree memory t = three(1 ether, 2 ether, 3 ether);
        post(t);
        // early: nothing active, claim reverts, finalize reverts
        vm.expectRevert(PotDistributor.NoActiveRoot.selector);
        pd.claim(alice, 1 ether, prove(t, 0));
        vm.expectRevert(abi.encodeWithSelector(PotDistributor.WindowOpen.selector, block.timestamp + CH));
        pd.finalize();
        vm.warp(block.timestamp + CH - 1);
        vm.expectRevert(PotDistributor.NoActiveRoot.selector);
        pd.claim(alice, 1 ether, prove(t, 0));
        vm.warp(block.timestamp + 1);
        // lazily finalized by the claim itself
        pd.claim(alice, 1 ether, prove(t, 0));
        assertEq(alice.balance, 1 ether);
        assertEq(pd.currentRound(), 1);
        // third party push: funds go to bob, not the caller
        vm.prank(carol);
        pd.claim(bob, 2 ether, prove(t, 1));
        assertEq(bob.balance, 2 ether);
        assertEq(carol.balance, 0);
        assertEq(pd.totalClaimed(), 3 ether);
        assertEq(pd.receivedTotal(), 10 ether);
    }

    function test_double_claim_and_cumulative_rounds() public {
        credit(10 ether);
        Tree memory t1 = three(1 ether, 2 ether, 3 ether);
        postAndFinalize(t1);
        pd.claim(alice, 1 ether, prove(t1, 0));
        vm.expectRevert(PotDistributor.NothingToClaim.selector);
        pd.claim(alice, 1 ether, prove(t1, 0));
        // round 2: alice cumulative 1.5 -> receives only the 0.5 delta
        credit(2 ether);
        Tree memory t2 = three(1.5 ether, 2.5 ether, 4 ether);
        postAndFinalize(t2);
        pd.claim(alice, 1.5 ether, prove(t2, 0));
        assertEq(alice.balance, 1.5 ether);
        // old-round proof no longer valid against the new root
        vm.expectRevert(PotDistributor.InvalidProof.selector);
        pd.claim(bob, 2 ether, prove(t1, 1));
        pd.claim(bob, 2.5 ether, prove(t2, 1));
        assertEq(bob.balance, 2.5 ether);
    }

    function test_wrong_proof_and_wrong_amount() public {
        credit(10 ether);
        Tree memory t = three(1 ether, 2 ether, 3 ether);
        postAndFinalize(t);
        vm.expectRevert(PotDistributor.InvalidProof.selector);
        pd.claim(alice, 2 ether, prove(t, 0)); // inflated amount
        vm.expectRevert(PotDistributor.InvalidProof.selector);
        pd.claim(carol, 1 ether, prove(t, 0)); // alice's proof for carol
        vm.expectRevert(PotDistributor.InvalidProof.selector);
        pd.claim(alice, 1 ether, new bytes32[](0));
        // inner node as leaf (second-preimage) fails: leaves are double-hashed
        bytes32[] memory p = prove(t, 0);
        vm.expectRevert(PotDistributor.InvalidProof.selector);
        pd.claim(address(uint160(uint256(p[0]))), 0, new bytes32[](0));
    }

    // ---------------------------------------------------------------- solvency
    function test_insolvent_root_rejected() public {
        credit(5 ether);
        Tree memory t = three(1 ether, 2 ether, 3 ether); // total 6 > received 5
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = sigs2(1, t.root, t.total, keccak256("inputs"), eb);
        vm.expectRevert(abi.encodeWithSelector(PotDistributor.Insolvent.selector, 6 ether, 5 ether));
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    function test_total_decrease_rejected() public {
        credit(10 ether);
        postAndFinalize(three(1 ether, 2 ether, 3 ether));
        Tree memory t2 = three(1 ether, 2 ether, 2 ether);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = sigs2(2, t2.root, t2.total, keccak256("inputs"), eb);
        vm.expectRevert(PotDistributor.TotalDecreased.selector);
        pd.postRoot(2, t2.root, t2.total, keccak256("inputs"), eb, s);
    }

    /// signers (buggy or colluding) sign a tree whose leaves sum to MORE than the declared total:
    /// the contract caps total payouts at the declared (solvency-checked) total.
    function test_leaves_exceed_declared_total_capped() public {
        credit(6 ether);
        Tree memory t = three(4 ether, 4 ether, 4 ether); // leaves sum 12
        uint64 round = 1;
        uint64 eb = uint64(block.number - 1);
        uint256 declared = 6 ether;
        pd.postRoot(round, t.root, declared, keccak256("inputs"), eb, sigs2(round, t.root, declared, keccak256("inputs"), eb));
        vm.warp(block.timestamp + CH);
        pd.finalize();
        pd.claim(alice, 4 ether, prove(t, 0));
        vm.expectRevert(PotDistributor.ExceedsRootTotal.selector);
        pd.claim(bob, 4 ether, prove(t, 1));
        assertEq(pd.totalClaimed(), 4 ether);
    }

    function test_bad_end_block() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number); // not in the past
        bytes[] memory s = sigs2(1, t.root, t.total, keccak256("inputs"), eb);
        vm.expectRevert(PotDistributor.BadEndBlock.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    function test_wrong_round_and_pending_exists() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = sigs2(2, t.root, t.total, keccak256("inputs"), eb);
        vm.expectRevert(PotDistributor.WrongRound.selector);
        pd.postRoot(2, t.root, t.total, keccak256("inputs"), eb, s);
        post(t);
        s = sigs2(1, t.root, t.total, keccak256("inputs"), eb);
        vm.expectRevert(PotDistributor.PendingExists.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    // ---------------------------------------------------------------- K-of-M signatures
    function test_threshold_one_sig_rejected() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = new bytes[](1);
        s[0] = sig(sk[0], 1, t.root, t.total, keccak256("inputs"), eb);
        vm.expectRevert(abi.encodeWithSelector(PotDistributor.BelowThreshold.selector, 1, 2));
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    function test_duplicate_signature_rejected() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = new bytes[](2);
        s[0] = sig(sk[0], 1, t.root, t.total, keccak256("inputs"), eb);
        s[1] = s[0];
        vm.expectRevert(PotDistributor.SignaturesNotSorted.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    function test_unsorted_signatures_rejected() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = new bytes[](2);
        s[0] = sig(sk[1], 1, t.root, t.total, keccak256("inputs"), eb);
        s[1] = sig(sk[0], 1, t.root, t.total, keccak256("inputs"), eb);
        vm.expectRevert(PotDistributor.SignaturesNotSorted.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    function test_non_signer_rejected() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        uint256 evil = 0xE11;
        bytes[] memory s = new bytes[](2);
        address ev = vm.addr(evil);
        bytes memory a = sig(sk[0], 1, t.root, t.total, keccak256("inputs"), eb);
        bytes memory b = sig(evil, 1, t.root, t.total, keccak256("inputs"), eb);
        (s[0], s[1]) = sa[0] < ev ? (a, b) : (b, a);
        vm.expectPartialRevert(PotDistributor.UnknownSigner.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    /// One honest signer + one malicious signer who signed a DIFFERENT root: the two signatures are over
    /// different digests, so they never combine into a quorum for either root.
    function test_malicious_root_cannot_reach_quorum() public {
        credit(10 ether);
        Tree memory honest = three(1 ether, 2 ether, 3 ether);
        Tree memory evil = three(0, 2 ether, 4 ether); // steals alice's 1 ether for carol
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = new bytes[](2);
        s[0] = sig(sk[0], 1, evil.root, evil.total, keccak256("inputs"), eb); // malicious signer
        s[1] = sig(sk[1], 1, honest.root, honest.total, keccak256("inputs"), eb); // honest signer
        try this.ext_post(1, evil.root, evil.total, eb, s) {
            fail();
        } catch {}
        // same mixed pair submitted for the honest root: must also fail (UnknownSigner or ordering error)
        try this.ext_post(1, honest.root, honest.total, eb, s) {
            fail();
        } catch {}
        // honest quorum (two honest signers) succeeds
        bytes[] memory h = new bytes[](2);
        h[0] = sig(sk[1], 1, honest.root, honest.total, keccak256("inputs"), eb);
        h[1] = sig(sk[2], 1, honest.root, honest.total, keccak256("inputs"), eb);
        pd.postRoot(1, honest.root, honest.total, keccak256("inputs"), eb, h);
    }

    function ext_post(uint64 r, bytes32 root, uint256 total, uint64 eb, bytes[] memory s) external {
        pd.postRoot(r, root, total, keccak256("inputs"), eb, s);
    }

    function test_malleable_high_s_rejected() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes32 d = pd.rootDigest(1, t.root, t.total, keccak256("inputs"), eb);
        (uint8 v, bytes32 r, bytes32 s0) = vm.sign(sk[0], d);
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(N - uint256(s0));
        uint8 v2 = v == 27 ? 28 : 27;
        bytes[] memory s = new bytes[](2);
        s[0] = abi.encodePacked(r, sHigh, v2);
        s[1] = sig(sk[1], 1, t.root, t.total, keccak256("inputs"), eb);
        vm.expectPartialRevert(ECDSA.ECDSAInvalidSignatureS.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    function test_signature_bound_to_chain_and_contract() public {
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = sigs2(1, t.root, t.total, keccak256("inputs"), eb);
        // same signers, second distributor: signatures for pd do not validate there (domain separator)
        PotDistributor pd2 = new PotDistributor(address(tl), guardian, sa, 2, CH);
        vm.deal(address(pd2), 10 ether);
        vm.expectPartialRevert(PotDistributor.UnknownSigner.selector);
        pd2.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
        // different chain id
        vm.chainId(999);
        vm.expectPartialRevert(PotDistributor.UnknownSigner.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }

    // ---------------------------------------------------------------- veto / pause
    function test_guardian_veto_then_repost_same_round() public {
        credit(10 ether);
        Tree memory bad = three(0, 0, 6 ether);
        post(bad);
        vm.expectRevert(PotDistributor.NotGuardian.selector);
        vm.prank(alice);
        pd.veto(1);
        vm.prank(guardian);
        pd.veto(1);
        vm.warp(block.timestamp + CH);
        vm.expectRevert(PotDistributor.NoPending.selector);
        pd.finalize();
        assertEq(pd.currentRound(), 0);
        Tree memory good = three(1 ether, 2 ether, 3 ether);
        post(good); // round 1 again
        vm.warp(block.timestamp + CH);
        pd.claim(carol, 3 ether, prove(good, 2));
        assertEq(carol.balance, 3 ether);
    }

    /// Devnet finding: re-posting the vetoed root with the same (still valid) signatures must fail.
    function test_vetoed_root_cannot_be_reposted_with_old_signatures() public {
        credit(10 ether);
        Tree memory bad = three(0, 0, 6 ether);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = sigs2(1, bad.root, bad.total, keccak256("inputs"), eb);
        pd.postRoot(1, bad.root, bad.total, keccak256("inputs"), eb, s);
        vm.prank(guardian);
        pd.veto(1);
        vm.expectRevert(PotDistributor.RootWasVetoed.selector);
        pd.postRoot(1, bad.root, bad.total, keccak256("inputs"), eb, s);
        // a recomputed (different) root for the same round is accepted
        Tree memory good = three(1 ether, 2 ether, 3 ether);
        pd.postRoot(1, good.root, good.total, keccak256("inputs"), eb, sigs2(1, good.root, good.total, keccak256("inputs"), eb));
        vm.warp(block.timestamp + CH);
        pd.claim(carol, 3 ether, prove(good, 2));
        assertEq(carol.balance, 3 ether);
    }

    function test_veto_after_window_but_before_finalize_while_paused() public {
        credit(10 ether);
        Tree memory bad = three(0, 0, 6 ether);
        post(bad);
        vm.prank(guardian);
        pd.pause();
        vm.warp(block.timestamp + CH + 1 days);
        vm.expectRevert(PotDistributor.IsPaused.selector);
        pd.finalize();
        vm.expectRevert(PotDistributor.IsPaused.selector);
        pd.claim(carol, 6 ether, prove(bad, 2));
        vm.prank(guardian);
        pd.veto(1);
        vm.prank(guardian);
        pd.unpause();
        vm.expectRevert(PotDistributor.NoActiveRoot.selector);
        pd.claim(carol, 6 ether, prove(bad, 2));
        assertEq(address(pd).balance, 10 ether);
    }

    function test_pause_blocks_claims_only_owner_cannot_withdraw() public {
        credit(10 ether);
        Tree memory t = three(1 ether, 2 ether, 3 ether);
        postAndFinalize(t);
        vm.expectRevert(PotDistributor.NotGuardian.selector);
        vm.prank(alice);
        pd.pause();
        vm.prank(guardian);
        pd.pause();
        vm.expectRevert(PotDistributor.IsPaused.selector);
        pd.claim(alice, 1 ether, prove(t, 0));
        vm.prank(guardian);
        pd.unpause();
        pd.claim(alice, 1 ether, prove(t, 0));
        assertEq(alice.balance, 1 ether);
    }

    // ---------------------------------------------------------------- governance via timelock
    function _tlCall(bytes memory data) internal returns (bytes32 id) {
        vm.prank(proposer);
        tl.schedule(address(pd), 0, data, bytes32(0), bytes32(uint256(1)), TL_DELAY);
        id = tl.hashOperation(address(pd), 0, data, bytes32(0), bytes32(uint256(1)));
    }

    function test_signer_rotation_only_via_timelock() public {
        address[] memory ns = new address[](3);
        uint256[3] memory nk = [uint256(0xD00D), uint256(0xE0E0), uint256(0xF00F)];
        for (uint256 i = 0; i < 3; ++i) {
            ns[i] = vm.addr(nk[i]);
        }
        // direct calls by anyone (guardian, signer, alice) revert
        vm.prank(guardian);
        vm.expectRevert(PotDistributor.NotTimelock.selector);
        pd.setSigners(ns, 2);
        vm.prank(sa[0]);
        vm.expectRevert(PotDistributor.NotTimelock.selector);
        pd.setSigners(ns, 2);
        // via timelock: scheduled, not executable before the delay
        bytes memory data = abi.encodeCall(PotDistributor.setSigners, (ns, 2));
        _tlCall(data);
        vm.expectRevert();
        tl.execute(address(pd), 0, data, bytes32(0), bytes32(uint256(1)));
        // pending root from the old set is cleared by the rotation
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory oldSigs = sigs2(1, t.root, t.total, keccak256("inputs"), eb);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, oldSigs);
        vm.warp(block.timestamp + TL_DELAY);
        uint64 epochBefore = pd.signerEpoch();
        tl.execute(address(pd), 0, data, bytes32(0), bytes32(uint256(1)));
        assertEq(pd.signerEpoch(), epochBefore + 1);
        assertTrue(pd.isSigner(ns[0]));
        assertFalse(pd.isSigner(sa[0]));
        (bytes32 pr,,,,) = pd.pending();
        assertEq(pr, bytes32(0));
        // old signers' signatures (old epoch) are now useless
        vm.expectPartialRevert(PotDistributor.UnknownSigner.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, oldSigs);
    }

    function test_guardian_and_period_only_timelock() public {
        vm.expectRevert(PotDistributor.NotTimelock.selector);
        pd.setGuardian(alice);
        vm.expectRevert(PotDistributor.NotTimelock.selector);
        pd.setChallengePeriod(2 hours);
        vm.prank(address(tl));
        vm.expectRevert(PotDistributor.BadChallengePeriod.selector);
        pd.setChallengePeriod(30 days);
        vm.prank(address(tl));
        pd.setGuardian(alice);
        assertEq(pd.guardian(), alice);
    }

    // ---------------------------------------------------------------- reentrancy / push
    function test_reentrancy_blocked() public {
        Reenterer re = new Reenterer(pd);
        credit(10 ether);
        address[] memory ac = new address[](2);
        ac[0] = address(re);
        ac[1] = alice;
        uint256[] memory cu = new uint256[](2);
        cu[0] = 1 ether;
        cu[1] = 1 ether;
        Tree memory t = tree(ac, cu);
        postAndFinalize(t);
        re.arm(1 ether, prove(t, 0), false);
        vm.expectRevert(PotDistributor.TransferFailed.selector);
        re.go();
        assertEq(pd.claimed(address(re)), 0);
        re.arm(1 ether, prove(t, 0), true); // swallows the reentrant failure
        re.go();
        assertEq(address(re).balance, 1 ether); // paid exactly once
        assertEq(pd.totalClaimed(), 1 ether);
    }

    function test_claimMany_skips_griefers_and_rolls_back() public {
        GasBurner gb = new GasBurner();
        Rejecter rj = new Rejecter();
        credit(10 ether);
        address[] memory ac = new address[](4);
        ac[0] = alice;
        ac[1] = address(gb);
        ac[2] = address(rj);
        ac[3] = bob;
        uint256[] memory cu = new uint256[](4);
        cu[0] = 1 ether;
        cu[1] = 1 ether;
        cu[2] = 1 ether;
        cu[3] = 2 ether;
        Tree memory t = tree(ac, cu);
        postAndFinalize(t);
        PotDistributor.Claim[] memory items = new PotDistributor.Claim[](4);
        for (uint256 i = 0; i < 4; ++i) {
            items[i] = PotDistributor.Claim(ac[i], cu[i], prove(t, i));
        }
        vm.prank(carol);
        pd.claimMany{gas: 1_000_000}(items);
        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 2 ether);
        assertEq(pd.claimed(address(gb)), 0);
        assertEq(pd.claimed(address(rj)), 0);
        assertEq(pd.totalClaimed(), 3 ether);
        assertEq(address(pd).balance, 7 ether);
        // idempotent re-push
        pd.claimMany(items);
        assertEq(pd.totalClaimed(), 3 ether);
    }

    function test_zero_address_leaf_rejected() public {
        credit(10 ether);
        address[] memory ac = new address[](2);
        ac[0] = address(0);
        ac[1] = alice;
        uint256[] memory cu = new uint256[](2);
        cu[0] = 1 ether;
        cu[1] = 1 ether;
        Tree memory t = tree(ac, cu);
        postAndFinalize(t);
        vm.expectRevert(PotDistributor.ZeroAddress.selector);
        pd.claim(address(0), 1 ether, prove(t, 0));
    }

    // ---------------------------------------------------------------- fuzz
    function testFuzz_distribution_never_exceeds_received(uint96 inflow, uint96[5] memory w) public {
        vm.assume(inflow > 0);
        credit(inflow);
        address[] memory ac = new address[](5);
        uint256[] memory cu = new uint256[](5);
        uint256 sw;
        for (uint256 i = 0; i < 5; ++i) {
            sw += uint256(w[i]) + 1;
        }
        for (uint256 i = 0; i < 5; ++i) {
            ac[i] = address(uint160(0x1000 + i));
            cu[i] = uint256(inflow) * (uint256(w[i]) + 1) / sw; // floor: sum <= inflow
        }
        Tree memory t = tree(ac, cu);
        postAndFinalize(t);
        for (uint256 i = 0; i < 5; ++i) {
            if (cu[i] > 0) pd.claim(ac[i], cu[i], prove(t, i));
        }
        assertLe(pd.totalClaimed(), uint256(inflow));
        assertEq(address(pd).balance + pd.totalClaimed(), uint256(inflow));
    }

    function testFuzz_wrong_amount_never_claims(uint256 amt) public {
        credit(10 ether);
        Tree memory t = three(1 ether, 2 ether, 3 ether);
        postAndFinalize(t);
        vm.assume(amt != 1 ether);
        vm.expectRevert(PotDistributor.InvalidProof.selector);
        pd.claim(alice, amt, prove(t, 0));
    }

    function testFuzz_random_signer_cannot_post(uint256 k1, uint256 k2) public {
        k1 = bound(k1, 1, 1e60);
        k2 = bound(k2, 1, 1e60);
        vm.assume(k1 != k2);
        address a1 = vm.addr(k1);
        address a2 = vm.addr(k2);
        vm.assume(!pd.isSigner(a1) && !pd.isSigner(a2));
        credit(10 ether);
        Tree memory t = three(1, 2, 3);
        uint64 eb = uint64(block.number - 1);
        bytes[] memory s = new bytes[](2);
        bytes memory x = sig(k1, 1, t.root, t.total, keccak256("inputs"), eb);
        bytes memory y = sig(k2, 1, t.root, t.total, keccak256("inputs"), eb);
        (s[0], s[1]) = a1 < a2 ? (x, y) : (y, x);
        vm.expectPartialRevert(PotDistributor.UnknownSigner.selector);
        pd.postRoot(1, t.root, t.total, keccak256("inputs"), eb, s);
    }
}
