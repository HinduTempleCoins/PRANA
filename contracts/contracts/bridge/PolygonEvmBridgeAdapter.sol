// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PausableGuardian} from "../PausableGuardian.sol";
import {IBridgeValidatorSet} from "../interfaces/IBridgeValidatorSet.sol";

/// @dev Mint/burn surface for tokens operated in burn/mint bridge mode. Mirrors
///      {PeggedBridgeVault.IBridgeMintable} (kept local so this adapter has no cross-import on the
///      stage-2 stub).
interface IBridgeMintableToken {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

/// @title PolygonEvmBridgeAdapter (BI4) — EVM↔EVM lock-mint adapter for a PRANA↔Polygon link.
///
/// @notice An ADAPTER-shaped bridge endpoint for a same-VM (EVM→EVM) Polygon link. It carries the
///         exact SAME trust model as the canonical bridge: a K-of-N {IBridgeValidatorSet}
///         attests off-chain to the remote event, and the inbound side only acts on a quorum of
///         validator signatures over a deterministic message digest. There is no single custodian.
///
///         OUTBOUND (PRANA side): a user locks (LOCK_RELEASE) or burns (BURN_MINT) a token; the
///         adapter emits a `MessageSent` carrying a deterministic `messageHash`. Validators observe
///         it and sign the mirror digest on the Polygon side.
///
///         INBOUND (mint side): anyone may submit an attested message — `(srcChainId, token,
///         recipient, amount, mode, srcRef, nonce)` plus `sigs`. The adapter recomputes the digest,
///         asks the validator set to {verifySignatures}, enforces PER-MESSAGE replay protection
///         (the full message hash, not just a nonce, is consumed once), then releases or mints.
///
/// @dev    "Adapter-shaped" = it deliberately re-uses the canonical bridge's validator-set /
///         attestation primitive rather than inventing a new one, so a Polygon link plugs into the
///         same security as the native canonical bridge. Per-token mode is set once and immutable.
///         Blast-radius limits (rolling daily cap + guardian pause) match {PeggedBridgeVault}.
///
///         ⚠️ DEPENDENCY: reuses {IBridgeValidatorSet} (the canonical declaration in
///         contracts/interfaces/IBridgeValidatorSet.sol, with {verifySignatures}). The concrete
///         {FederatedBridgeValidatorSet} (BI1) is being built by a sibling agent; deploy-time wiring
///         points `validatorSet` at it. If BI1's external surface differs, ORCHESTRATOR reconciles.
contract PolygonEvmBridgeAdapter is PausableGuardian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice EIP-712-style domain tag baked into every digest so signatures cannot be replayed
    ///         onto a different adapter / contract type.
    string public constant DOMAIN = "PRANA.PolygonEvmBridgeAdapter.v1";

    enum Mode {
        UNSET,        // token not configured — all ops revert
        LOCK_RELEASE, // escrow on lock, transfer on release
        BURN_MINT     // burn on lock, mint on release
    }

    /// @notice The K-of-N attestation authority (shared with the canonical bridge).
    IBridgeValidatorSet public immutable validatorSet;

    /// @notice The EVM chain id of the linked Polygon network (config; used to bind outbound refs).
    uint256 public immutable remoteChainId;

    /// @notice Per-token bridge mode (immutable once set).
    mapping(address => Mode) public modeOf;

    /// @notice Monotonic nonce for outbound messages from this chain.
    uint256 public outboundNonce;

    /// @notice Per-MESSAGE replay guard: the full inbound message hash is consumed exactly once.
    mapping(bytes32 => bool) public consumedMessage;

    // --- daily release cap (rolling 24h window, per token) -----------------
    uint256 public constant DAY = 1 days;
    mapping(address => uint256) public dailyCap;
    mapping(address => uint256) public releasedInWindow;
    mapping(address => uint256) public windowStart;

    // --- events ------------------------------------------------------------
    event ModeSet(address indexed token, Mode mode);
    event DailyCapSet(address indexed token, uint256 cap);

    /// @notice Outbound cross-EVM message. `messageHash` is what validators attest to on the far side.
    event MessageSent(
        bytes32 indexed messageHash,
        uint256 indexed nonce,
        address indexed token,
        address sender,
        uint256 amount,
        Mode mode,
        bytes32 destinationRef
    );

    /// @notice Inbound attested message consumed (release or mint executed).
    event MessageConsumed(
        bytes32 indexed messageHash,
        uint256 indexed srcChainId,
        address indexed token,
        address recipient,
        uint256 amount,
        Mode mode,
        bytes32 srcRef
    );

    // --- errors ------------------------------------------------------------
    error ZeroAddress();
    error ZeroAmount();
    error ModeAlreadySet();
    error WrongMode();
    error TokenNotConfigured();
    error MessageAlreadyConsumed(bytes32 messageHash);
    error QuorumNotMet();
    error WrongSourceChain(uint256 got, uint256 expected);
    error DailyCapExceeded(uint256 cap, uint256 wouldBe);

    /// @param unpauseDelay_ timelock (seconds) before a proposed unpause can execute.
    /// @param admin_ receives DEFAULT_ADMIN_ROLE + GUARDIAN_ROLE.
    /// @param validatorSet_ the K-of-N attestation authority.
    /// @param remoteChainId_ EVM chain id of the linked Polygon network.
    constructor(
        uint256 unpauseDelay_,
        address admin_,
        address validatorSet_,
        uint256 remoteChainId_
    ) PausableGuardian(unpauseDelay_, admin_) {
        if (admin_ == address(0) || validatorSet_ == address(0)) revert ZeroAddress();
        if (remoteChainId_ == 0) revert ZeroAmount();
        validatorSet = IBridgeValidatorSet(validatorSet_);
        remoteChainId = remoteChainId_;
    }

    // =======================================================================
    //                          ADMIN CONFIG
    // =======================================================================

    /// @notice Set a token's bridge mode. Callable once per token (immutable thereafter).
    function setMode(address token, Mode mode) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (mode == Mode.UNSET) revert WrongMode();
        if (modeOf[token] != Mode.UNSET) revert ModeAlreadySet();
        modeOf[token] = mode;
        emit ModeSet(token, mode);
    }

    /// @notice Set (or clear, with 0) a token's rolling-24h release cap.
    function setDailyCap(address token, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        dailyCap[token] = cap;
        emit DailyCapSet(token, cap);
    }

    // =======================================================================
    //                       OUTBOUND (user -> bridge)
    // =======================================================================

    /// @notice Lock (LOCK_RELEASE) or burn (BURN_MINT) `amount` of `token` and emit a cross-EVM
    ///         message for relay to Polygon.
    /// @param destinationRef opaque ref (e.g. abi-encoded recipient on the destination chain).
    /// @return nonce the outbound nonce assigned.
    /// @return messageHash the deterministic digest validators will attest to on the far side.
    function bridgeOut(address token, uint256 amount, bytes32 destinationRef)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 nonce, bytes32 messageHash)
    {
        Mode mode = modeOf[token];
        if (mode == Mode.UNSET) revert TokenNotConfigured();
        if (amount == 0) revert ZeroAmount();

        nonce = outboundNonce++;

        if (mode == Mode.LOCK_RELEASE) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        } else {
            // BURN_MINT: pull in then burn this adapter's own balance.
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            IBridgeMintableToken(token).burn(amount);
        }

        // Outbound digest binds THIS chain as the source so the mirror side keys off it.
        messageHash = _digest(block.chainid, token, msg.sender, amount, mode, destinationRef, nonce);
        emit MessageSent(messageHash, nonce, token, msg.sender, amount, mode, destinationRef);
    }

    // =======================================================================
    //                    INBOUND (attested message -> user)
    // =======================================================================

    /// @notice Consume an attested cross-EVM message: release (LOCK_RELEASE) or mint (BURN_MINT)
    ///         `amount` of `token` to `recipient`. Permissionless to submit; gated by a validator-set
    ///         signature quorum over the deterministic digest, with per-message replay protection.
    /// @param srcChainId  EVM chain id of the remote (must equal `remoteChainId`).
    /// @param token       the token to release/mint on this side.
    /// @param recipient   who receives the funds.
    /// @param amount      amount to release/mint.
    /// @param mode        the mode of the remote action (must match this token's configured mode).
    /// @param srcRef      opaque ref to the remote lock/burn (for traceability).
    /// @param nonce       the remote outbound nonce (part of the unique message identity).
    /// @param sigs        K-of-N validator signatures over the digest.
    function bridgeIn(
        uint256 srcChainId,
        address token,
        address recipient,
        uint256 amount,
        Mode mode,
        bytes32 srcRef,
        uint256 nonce,
        bytes[] calldata sigs
    ) external whenNotPaused nonReentrant {
        if (srcChainId != remoteChainId) revert WrongSourceChain(srcChainId, remoteChainId);
        if (modeOf[token] == Mode.UNSET) revert TokenNotConfigured();
        if (modeOf[token] != mode) revert WrongMode();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        bytes32 messageHash = _digest(srcChainId, token, recipient, amount, mode, srcRef, nonce);

        // Per-message replay protection: the full message hash is consumable exactly once.
        if (consumedMessage[messageHash]) revert MessageAlreadyConsumed(messageHash);

        // Quorum check against the shared validator set.
        if (!validatorSet.verifySignatures(messageHash, sigs)) revert QuorumNotMet();

        consumedMessage[messageHash] = true;
        _accountDailyCap(token, amount);

        if (mode == Mode.LOCK_RELEASE) {
            IERC20(token).safeTransfer(recipient, amount);
        } else {
            IBridgeMintableToken(token).mint(recipient, amount);
        }

        emit MessageConsumed(messageHash, srcChainId, token, recipient, amount, mode, srcRef);
    }

    // =======================================================================
    //                            VIEWS / INTERNAL
    // =======================================================================

    /// @notice Public digest builder so off-chain validators/relayers compute the exact same hash.
    function computeMessageHash(
        uint256 srcChainId,
        address token,
        address party,
        uint256 amount,
        Mode mode,
        bytes32 ref,
        uint256 nonce
    ) external view returns (bytes32) {
        return _digest(srcChainId, token, party, amount, mode, ref, nonce);
    }

    /// @dev Deterministic, domain- and adapter-bound digest. Binds `address(this)` so a signature for
    ///      one adapter instance cannot be replayed against another.
    function _digest(
        uint256 srcChainId,
        address token,
        address party,
        uint256 amount,
        Mode mode,
        bytes32 ref,
        uint256 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN,
                address(this),
                srcChainId,
                token,
                party,
                amount,
                uint8(mode),
                ref,
                nonce
            )
        );
    }

    /// @dev Roll the 24h window if elapsed, then enforce the per-token daily cap (0 == unlimited).
    function _accountDailyCap(address token, uint256 amount) internal {
        uint256 cap = dailyCap[token];
        if (block.timestamp >= windowStart[token] + DAY) {
            windowStart[token] = block.timestamp;
            releasedInWindow[token] = 0;
        }
        uint256 wouldBe = releasedInWindow[token] + amount;
        if (cap != 0 && wouldBe > cap) revert DailyCapExceeded(cap, wouldBe);
        releasedInWindow[token] = wouldBe;
    }
}
