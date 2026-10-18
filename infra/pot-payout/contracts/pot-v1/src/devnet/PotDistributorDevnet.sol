// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PotDistributor — the hardcoded PRANA pool pot (Devcoin-style shares, made trust-minimised)
/// @notice From the pot hardfork block onward, consensus credits 98% of every block reward (and every
///         uncle reward) to THIS address with a plain balance credit (no code runs, no receive()).
///         Each round, K-of-M independent signers — each of whom recomputed the round from the public
///         inputs — sign a Merkle root of CUMULATIVE earnings per address. After a challenge window in
///         which the guardian may veto, the root becomes claimable. Recipients pull with a proof
///         (anyone may push on their behalf; funds always go to the leaf's account).
/// @dev    Deliberately immutable: no proxy, no owner, no withdraw, no sweep, no arbitrary call.
///         The only way value leaves is `claim` / `claimMany` to an account proven in the active root,
///         bounded by (a) that account's cumulative amount and (b) the root's declared total, which is
///         itself bounded by everything this contract has ever received.
contract PotDistributorDevnet is EIP712, ReentrancyGuard {
    // ------------------------------------------------------------------ constants
    uint256 public constant MIN_SIGNERS = 3;
    uint256 public constant MAX_SIGNERS = 32;
    uint256 public constant MIN_THRESHOLD = 2;
    uint64 public constant MIN_CHALLENGE = 60 seconds; // DEVNET ONLY
    uint64 public constant MAX_CHALLENGE = 14 days;
    /// @notice gas forwarded when a third party pushes a payout (bounds griefing of batch pushers).
    uint256 public constant PUSH_GAS = 60_000;

    bytes32 public constant ROOT_TYPEHASH = keccak256(
        "PotRoot(uint64 round,bytes32 root,uint256 total,bytes32 inputsHash,uint64 endBlock,uint64 signerEpoch)"
    );

    // ------------------------------------------------------------------ roles
    /// @notice governance (DAO TimelockController): signer set, threshold, guardian, challenge period.
    address public immutable timelock;
    /// @notice guardian (separate multisig): veto a pending root, pause/unpause claims. Cannot move funds.
    address public guardian;

    // ------------------------------------------------------------------ signer set
    address[] private _signers;
    mapping(address => bool) public isSigner;
    uint256 public threshold;
    /// @notice bumped on every signer-set change; part of the signed struct, so signatures made for an
    ///         old signer set can never be replayed against a new one.
    uint64 public signerEpoch;

    // ------------------------------------------------------------------ rounds
    struct RootInfo {
        bytes32 root; // Merkle root of keccak(keccak(abi.encode(account, cumulative)))
        uint256 total; // sum of all cumulative amounts in the tree (declared, signed)
        bytes32 inputsHash; // sha256 of the canonical public round bundle (shares + AI verdicts + inflow)
        uint64 endBlock; // last chain block whose inflow the round accounts for
        uint64 postedAt; // timestamp the root was posted (challenge window start)
    }

    uint64 public challengePeriod;
    bool public paused;

    uint64 public currentRound; // last FINALIZED round (0 = none yet)
    RootInfo public active; // the finalized root claims are checked against
    uint64 public pendingRound; // round number of `pending` (meaningful only if pending.root != 0)
    RootInfo public pending;

    /// @notice EIP-712 digests of roots the guardian/timelock vetoed. A vetoed (round, root, total, inputsHash,
    ///         endBlock, signerEpoch) can never be posted again, even though its signatures stay valid.
    mapping(bytes32 => bool) public vetoedDigest;

    // ------------------------------------------------------------------ accounting
    uint256 public totalClaimed;
    mapping(address => uint256) public claimed;

    struct Claim {
        address account;
        uint256 cumulative;
        bytes32[] proof;
    }

    // ------------------------------------------------------------------ events
    event RootPosted(
        uint64 indexed round, bytes32 root, uint256 total, bytes32 inputsHash, uint64 endBlock, address[] signers
    );
    event RootFinalized(uint64 indexed round, bytes32 root, uint256 total);
    event RootVetoed(uint64 indexed round, bytes32 root, address by);
    event PendingCleared(uint64 indexed round, bytes32 root);
    event Claimed(address indexed account, uint256 amount, uint256 cumulative, uint64 round);
    event PushFailed(address indexed account, uint256 amount);
    event SignersUpdated(uint64 indexed signerEpoch, address[] signers, uint256 threshold);
    event GuardianUpdated(address indexed guardian);
    event ChallengePeriodUpdated(uint64 challengePeriod);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ------------------------------------------------------------------ errors
    error NotTimelock();
    error NotGuardian();
    error IsPaused();
    error BadSignerSet();
    error BadChallengePeriod();
    error ZeroAddress();
    error PendingExists();
    error NoPending();
    error WrongRound();
    error ZeroRoot();
    error TotalDecreased();
    error Insolvent(uint256 total, uint256 received);
    error BadEndBlock();
    error SignaturesNotSorted();
    error UnknownSigner(address recovered);
    error BelowThreshold(uint256 got, uint256 need);
    error WindowOpen(uint256 claimableAt);
    error NoActiveRoot();
    error InvalidProof();
    error NothingToClaim();
    error ExceedsRootTotal();
    error TransferFailed();
    error RootWasVetoed();

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock();
        _;
    }

    modifier onlyGuardianOrTimelock() {
        if (msg.sender != guardian && msg.sender != timelock) revert NotGuardian();
        _;
    }

    constructor(
        address timelock_,
        address guardian_,
        address[] memory signers_,
        uint256 threshold_,
        uint64 challengePeriod_
    ) EIP712("PRANA PotDistributor", "1") {
        if (timelock_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        timelock = timelock_;
        guardian = guardian_;
        _setSigners(signers_, threshold_);
        _setChallengePeriod(challengePeriod_);
        emit GuardianUpdated(guardian_);
    }

    // NOTE: intentionally NO receive()/fallback(). Consensus credits this address directly (AddBalance);
    // accidental plain transfers revert. Force-sent value (selfdestruct) simply becomes distributable.

    // ================================================================== views
    /// @notice everything this contract has ever received (consensus credits + forced sends).
    function receivedTotal() public view returns (uint256) {
        return address(this).balance + totalClaimed;
    }

    function signers() external view returns (address[] memory) {
        return _signers;
    }

    /// @notice the EIP-712 digest signers must sign for a given round.
    function rootDigest(uint64 round, bytes32 root, uint256 total, bytes32 inputsHash, uint64 endBlock)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(ROOT_TYPEHASH, round, root, total, inputsHash, endBlock, signerEpoch))
        );
    }

    function leaf(address account, uint256 cumulative) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }

    /// @notice claimable amount for `account` given its cumulative proof against the active root
    ///         (0 if the proof is wrong or nothing is due). Does not account for a due-but-unfinalized root.
    function claimable(address account, uint256 cumulative, bytes32[] calldata proof)
        external
        view
        returns (uint256)
    {
        if (active.root == bytes32(0) || !MerkleProof.verifyCalldata(proof, active.root, leaf(account, cumulative)))
        {
            return 0;
        }
        uint256 c = claimed[account];
        return cumulative > c ? cumulative - c : 0;
    }

    function pendingClaimableAt() external view returns (uint256) {
        if (pending.root == bytes32(0)) return 0;
        return uint256(pending.postedAt) + challengePeriod;
    }

    // ================================================================== rounds
    /// @notice Post the next round's root with >= threshold signatures. Permissionless relay: anyone holding
    ///         enough valid signatures may submit. Signatures must be from DISTINCT current signers and be
    ///         ordered by strictly ascending recovered address (this is how duplicates are rejected).
    function postRoot(
        uint64 round,
        bytes32 root,
        uint256 total,
        bytes32 inputsHash,
        uint64 endBlock,
        bytes[] calldata signatures
    ) external nonReentrant {
        if (pending.root != bytes32(0)) revert PendingExists();
        if (round != currentRound + 1) revert WrongRound();
        if (root == bytes32(0)) revert ZeroRoot();
        if (total < active.total) revert TotalDecreased();
        uint256 received = receivedTotal();
        if (total > received) revert Insolvent(total, received);
        if (endBlock <= active.endBlock || endBlock >= block.number) revert BadEndBlock();

        bytes32 digest = rootDigest(round, root, total, inputsHash, endBlock);
        if (vetoedDigest[digest]) revert RootWasVetoed();
        uint256 n = signatures.length;
        if (n < threshold) revert BelowThreshold(n, threshold);
        address[] memory who = new address[](n);
        address last = address(0);
        for (uint256 i = 0; i < n; ++i) {
            // OZ ECDSA.recover: rejects malleable (high-s) signatures, bad v, bad length, and address(0).
            address s = ECDSA.recover(digest, signatures[i]);
            if (s <= last) revert SignaturesNotSorted();
            if (!isSigner[s]) revert UnknownSigner(s);
            who[i] = s;
            last = s;
        }

        pendingRound = round;
        pending = RootInfo({
            root: root,
            total: total,
            inputsHash: inputsHash,
            endBlock: endBlock,
            postedAt: uint64(block.timestamp)
        });
        emit RootPosted(round, root, total, inputsHash, endBlock, who);
    }

    /// @notice Make the pending root active once its challenge window has passed. Anyone may call;
    ///         `claim` also does it lazily. Blocked while paused (so a paused emergency can still be vetoed).
    function finalize() external nonReentrant {
        if (paused) revert IsPaused();
        if (!_finalizeIfDue()) {
            if (pending.root == bytes32(0)) revert NoPending();
            revert WindowOpen(uint256(pending.postedAt) + challengePeriod);
        }
    }

    /// @notice Guardian (or timelock) rejects the pending root. The round number is NOT consumed: the
    ///         round is recomputed and re-posted. Can be called any time before finalization.
    function veto(uint64 round) external onlyGuardianOrTimelock {
        if (pending.root == bytes32(0)) revert NoPending();
        if (round != pendingRound) revert WrongRound();
        bytes32 r = pending.root;
        // the pending root was posted under the current signerEpoch (rotation clears pending), so this is the
        // exact digest its signatures cover; blacklist it so the same signatures cannot re-post it
        vetoedDigest[rootDigest(round, r, pending.total, pending.inputsHash, pending.endBlock)] = true;
        delete pending;
        emit RootVetoed(round, r, msg.sender);
    }

    // ================================================================== claims
    /// @notice Pay `account` its cumulative earnings minus what it already received. Anyone may call;
    ///         funds always go to `account`. If msg.sender == account all gas is forwarded, otherwise
    ///         PUSH_GAS (a third party cannot be gas-griefed by a recipient contract).
    function claim(address account, uint256 cumulative, bytes32[] calldata proof) external nonReentrant {
        if (paused) revert IsPaused();
        _finalizeIfDue();
        uint256 amount = _account(account, cumulative, proof);
        bool ok = _send(account, amount, msg.sender == account ? gasleft() : PUSH_GAS);
        if (!ok) revert TransferFailed();
        emit Claimed(account, amount, cumulative, currentRound);
    }

    /// @notice Batched push for small balances. Invalid proofs revert the batch (pusher error); a
    ///         recipient that rejects payment is skipped and its accounting rolled back (it can self-claim).
    function claimMany(Claim[] calldata items) external nonReentrant {
        if (paused) revert IsPaused();
        _finalizeIfDue();
        uint256 n = items.length;
        for (uint256 i = 0; i < n; ++i) {
            Claim calldata c = items[i];
            if (c.cumulative <= claimed[c.account]) continue; // already paid: idempotent pushes
            uint256 prev = claimed[c.account];
            uint256 amount = _account(c.account, c.cumulative, c.proof);
            if (!_send(c.account, amount, PUSH_GAS)) {
                // roll back exactly this account's effects (restores the pre-call state)
                claimed[c.account] = prev;
                totalClaimed -= amount;
                emit PushFailed(c.account, amount);
            } else {
                emit Claimed(c.account, amount, c.cumulative, currentRound);
            }
        }
    }

    // ================================================================== guardian
    function pause() external onlyGuardianOrTimelock {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyGuardianOrTimelock {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ================================================================== governance (timelock only)
    function setSigners(address[] calldata signers_, uint256 threshold_) external onlyTimelock {
        _setSigners(signers_, threshold_);
        // A root posted by the old set must not survive a rotation (rotations usually mean compromise).
        if (pending.root != bytes32(0)) {
            emit PendingCleared(pendingRound, pending.root);
            delete pending;
        }
    }

    function setGuardian(address guardian_) external onlyTimelock {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    function setChallengePeriod(uint64 p) external onlyTimelock {
        _setChallengePeriod(p);
    }

    // ================================================================== internals
    function _finalizeIfDue() internal returns (bool) {
        if (pending.root == bytes32(0)) return false;
        if (block.timestamp < uint256(pending.postedAt) + challengePeriod) return false;
        // Re-check solvency + monotonicity at activation (received only grows, but be explicit).
        RootInfo memory p = pending;
        if (p.total > receivedTotal() || p.total < active.total) return false;
        active = p;
        currentRound = pendingRound;
        delete pending;
        emit RootFinalized(currentRound, p.root, p.total);
        return true;
    }

    /// @dev checks + effects for one claim. Returns the amount to send.
    function _account(address account, uint256 cumulative, bytes32[] calldata proof) internal returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        bytes32 r = active.root;
        if (r == bytes32(0)) revert NoActiveRoot();
        if (!MerkleProof.verifyCalldata(proof, r, leaf(account, cumulative))) revert InvalidProof();
        uint256 already = claimed[account];
        if (cumulative <= already) revert NothingToClaim();
        uint256 amount = cumulative - already;
        if (totalClaimed + amount > active.total) revert ExceedsRootTotal();
        // effects before interaction
        claimed[account] = cumulative;
        totalClaimed += amount;
        return amount;
    }

    /// @dev native transfer that does NOT copy return data (no return-bomb: a recipient cannot make the
    ///      caller pay for copying a huge revert/return payload). State is already updated by the caller.
    function _send(address to, uint256 amount, uint256 gasLimit) internal returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
    }

    function _setSigners(address[] memory s, uint256 k) internal {
        uint256 m = s.length;
        if (m < MIN_SIGNERS || m > MAX_SIGNERS || k < MIN_THRESHOLD || k > m) revert BadSignerSet();
        // clear the old set
        uint256 old = _signers.length;
        for (uint256 i = 0; i < old; ++i) {
            isSigner[_signers[i]] = false;
        }
        delete _signers;
        for (uint256 i = 0; i < m; ++i) {
            address a = s[i];
            if (a == address(0) || isSigner[a]) revert BadSignerSet(); // zero or duplicate
            isSigner[a] = true;
            _signers.push(a);
        }
        threshold = k;
        unchecked {
            ++signerEpoch;
        }
        emit SignersUpdated(signerEpoch, s, k);
    }

    function _setChallengePeriod(uint64 p) internal {
        if (p < MIN_CHALLENGE || p > MAX_CHALLENGE) revert BadChallengePeriod();
        challengePeriod = p;
        emit ChallengePeriodUpdated(p);
    }
}
