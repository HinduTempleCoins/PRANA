// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PausableGuardian} from "./PausableGuardian.sol";

/// @dev Minimal mint/burn interface for tokens operated in burn/mint bridge mode.
interface IBridgeMintable {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

/// @title PeggedBridgeVault — bridge STAGE-2 single-custodian escrow/mint stub
///
/// @notice ⚠️⚠️ TRUSTED, NON-FINAL BRIDGE. READ BEFORE USING. ⚠️⚠️
///         This is a *stage-2* bridge: a single off-chain custodian (the holder of
///         `CUSTODIAN_ROLE`) is fully trusted to (a) observe `BridgeLocked` events on this side,
///         credit the user on the destination chain, and (b) release/mint here in response to
///         locks on the other side. THERE IS NO ON-CHAIN PROOF OF THE REMOTE EVENT — the custodian
///         could in principle release funds with no matching deposit. The trust model is therefore
///         identical to a centralized exchange's deposit/withdraw, NOT a trustless bridge.
///
///         Blast-radius limits are deliberately included so a *compromised* custodian cannot drain
///         everything instantly:
///           - a per-token DAILY RELEASE CAP (rolling 24h window), and
///           - a guardian PAUSE circuit-breaker (via PausableGuardian, with timelocked unpause).
///
///         This contract WILL BE REPLACED by the audited, two-way, light-client / multi-attester
///         STAGE-3 bridge. Do not build large TVL on top of it.
///
/// @dev Per-token mode is set ONCE by an admin and is immutable thereafter:
///        - LOCK_RELEASE: tokens are escrowed on lock and transferred back on release.
///        - BURN_MINT:    tokens are pulled in and burned on `burnForBridge`; minted on
///                        `mintFromBridge`. Requires this vault to hold mint authority on the token
///                        and the token to expose {IBridgeMintable}.
contract PeggedBridgeVault is PausableGuardian {
    using SafeERC20 for IERC20;

    bytes32 public constant CUSTODIAN_ROLE = keccak256("CUSTODIAN_ROLE");

    enum Mode {
        UNSET,        // token not configured — all ops revert
        LOCK_RELEASE, // escrow on lock, transfer on release
        BURN_MINT     // burn on lock, mint on release
    }

    /// @notice Per-token bridge mode (immutable once set).
    mapping(address => Mode) public modeOf;

    /// @notice Monotonic nonce for outbound (lock/burn) messages from this chain.
    uint256 public outboundNonce;

    /// @notice Inbound nonce replay guard for release/mint messages from the custodian.
    mapping(uint256 => bool) public usedInboundNonce;

    // --- daily release cap (rolling 24h window, per token) -----------------
    uint256 public constant DAY = 1 days;
    /// @notice Per-token daily cap on released/minted amount. 0 == disabled (unlimited).
    mapping(address => uint256) public dailyCap;
    /// @notice Amount released in the current window, per token.
    mapping(address => uint256) public releasedInWindow;
    /// @notice Start timestamp of the current window, per token.
    mapping(address => uint256) public windowStart;

    // --- events ------------------------------------------------------------
    event ModeSet(address indexed token, Mode mode);
    event DailyCapSet(address indexed token, uint256 cap);
    event BridgeLocked(
        uint256 indexed nonce,
        address indexed token,
        address indexed sender,
        uint256 amount,
        bytes32 destinationRef
    );
    event BridgeBurned(
        uint256 indexed nonce,
        address indexed token,
        address indexed sender,
        uint256 amount,
        bytes32 destinationRef
    );
    event BridgeReleased(
        uint256 indexed nonce,
        address indexed token,
        address indexed recipient,
        uint256 amount,
        bytes32 sourceRef
    );
    event BridgeMinted(
        uint256 indexed nonce,
        address indexed token,
        address indexed recipient,
        uint256 amount,
        bytes32 sourceRef
    );

    // --- errors ------------------------------------------------------------
    error ZeroAddress();
    error ZeroAmount();
    error ModeAlreadySet();
    error WrongMode();
    error TokenNotConfigured();
    error NonceAlreadyUsed(uint256 nonce);
    error DailyCapExceeded(uint256 cap, uint256 wouldBe);

    /// @param unpauseDelay_ timelock (seconds) before a proposed unpause can execute.
    /// @param admin_ receives DEFAULT_ADMIN_ROLE + GUARDIAN_ROLE (via PausableGuardian).
    /// @param custodian_ the single trusted bridge operator (CUSTODIAN_ROLE).
    constructor(uint256 unpauseDelay_, address admin_, address custodian_)
        PausableGuardian(unpauseDelay_, admin_)
    {
        if (admin_ == address(0) || custodian_ == address(0)) revert ZeroAddress();
        _grantRole(CUSTODIAN_ROLE, custodian_);
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

    /// @notice LOCK_RELEASE mode: escrow `amount` of `token`, emitting a lock the custodian relays.
    /// @param destinationRef opaque ref (e.g. encoded recipient on the destination chain).
    function lockForBridge(address token, uint256 amount, bytes32 destinationRef)
        external
        whenNotPaused
        returns (uint256 nonce)
    {
        if (modeOf[token] != Mode.LOCK_RELEASE) revert WrongMode();
        if (amount == 0) revert ZeroAmount();

        nonce = outboundNonce++;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit BridgeLocked(nonce, token, msg.sender, amount, destinationRef);
    }

    /// @notice BURN_MINT mode: pull `amount` of `token` and burn it, emitting a burn the custodian
    ///         relays so the destination chain can mint.
    function burnForBridge(address token, uint256 amount, bytes32 destinationRef)
        external
        whenNotPaused
        returns (uint256 nonce)
    {
        if (modeOf[token] != Mode.BURN_MINT) revert WrongMode();
        if (amount == 0) revert ZeroAmount();

        nonce = outboundNonce++;
        // Pull in then burn this vault's own balance. Requires token approval from the user.
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IBridgeMintable(token).burn(amount);
        emit BridgeBurned(nonce, token, msg.sender, amount, destinationRef);
    }

    // =======================================================================
    //                    INBOUND (custodian -> user)
    // =======================================================================

    /// @notice LOCK_RELEASE mode: release escrowed `token` to `recipient` in response to a remote
    ///         lock identified by `sourceRef`. Custodian-only; nonce-replay-guarded; cap-limited.
    function releaseFromBridge(
        address token,
        address recipient,
        uint256 amount,
        bytes32 sourceRef,
        uint256 nonce
    ) external whenNotPaused onlyRole(CUSTODIAN_ROLE) {
        if (modeOf[token] != Mode.LOCK_RELEASE) revert WrongMode();
        _consumeInbound(token, recipient, amount, nonce);

        IERC20(token).safeTransfer(recipient, amount);
        emit BridgeReleased(nonce, token, recipient, amount, sourceRef);
    }

    /// @notice BURN_MINT mode: mint `token` to `recipient` in response to a remote burn identified
    ///         by `sourceRef`. Custodian-only; nonce-replay-guarded; cap-limited.
    function mintFromBridge(
        address token,
        address recipient,
        uint256 amount,
        bytes32 sourceRef,
        uint256 nonce
    ) external whenNotPaused onlyRole(CUSTODIAN_ROLE) {
        if (modeOf[token] != Mode.BURN_MINT) revert WrongMode();
        _consumeInbound(token, recipient, amount, nonce);

        IBridgeMintable(token).mint(recipient, amount);
        emit BridgeMinted(nonce, token, recipient, amount, sourceRef);
    }

    // =======================================================================
    //                            INTERNAL
    // =======================================================================

    /// @dev Validate an inbound message: token configured, non-zero recipient/amount, nonce unused,
    ///      and the rolling daily cap not exceeded. Marks the nonce used and books the cap.
    function _consumeInbound(address token, address recipient, uint256 amount, uint256 nonce)
        internal
    {
        if (modeOf[token] == Mode.UNSET) revert TokenNotConfigured();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (usedInboundNonce[nonce]) revert NonceAlreadyUsed(nonce);
        usedInboundNonce[nonce] = true;
        _accountDailyCap(token, amount);
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
