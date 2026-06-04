// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBridgeValidatorSet} from "./IBridgeValidatorSet.sol";

/// @notice The mint surface this bridge needs from {WrappedEcosystemToken}. The bridge must hold
///         `CUSTODIAN_ROLE` on each registered wrapper for `mint` to succeed.
/// @dev    Signature MUST match {WrappedEcosystemToken-mint(address,uint256,bytes32)} exactly — the
///         third arg is the opaque origin-lock ref recorded in the wrapper's {WrappedMinted} event.
interface IWrappedEcosystemTokenMint {
    function mint(address to, uint256 amount, bytes32 originLockRef) external;
}

/// @title GrapheneDepositBridge (backlog BI7) — Graphene/Hive-Engine → PRANA deposit bridge
///
/// @notice ⚠️⚠️ TRUSTED, NON-FINAL (STAGE-2) BRIDGE. READ THE TRUST MODEL BEFORE USING. ⚠️⚠️
///
///         This contract mints PRANA-side {WrappedEcosystemToken}s (wMELEK / wVKBT / wCURE) against
///         deposits that happened on a Graphene-family chain (MELEK) or a Hive-Engine sidechain.
///         Graphene/Hive-Engine deposits CANNOT be proven on PRANA with an on-chain light client, so
///         a FEDERATED ATTESTER SET stands in for that proof:
///
///           1. A user sends N MELEK to the bridge's custody account on the MELEK chain.
///           2. K-of-N off-chain attesters each observe that transfer and call {attestDeposit} with
///              the same (token, recipient, amount, depositRef). `depositRef` is the Graphene tx id /
///              sequence number — globally unique per deposit.
///           3. When the K-th distinct active attester lands, the bridge mints `amount` of the
///              registered wrapper to `recipient` (one mint per depositRef, ever).
///
///         The trust model is therefore the SAME as {PeggedBridgeVault} / {WrappedEcosystemToken}:
///         the attester federation is fully trusted to report Graphene deposits/withdrawals honestly.
///         There is NO on-chain proof of the remote event. A colluding K-of-N could mint unbacked
///         supply. K-of-N (vs single custodian) is the only hardening here; the audited light-client
///         bridge is stage 3 and WILL replace this.
///
///         VALIDATOR-SET WIRING (two modes, mutually exclusive at any moment):
///           - EXTERNAL set: point `validatorSet` at an {IBridgeValidatorSet} (the federated BI1
///             contract). Membership (`isValidator`) and the K threshold (`quorum`) come from it.
///           - BUILT-IN set: leave `validatorSet == address(0)`; grant {ATTESTER_ROLE} to the N
///             attesters and set `localQuorum` to K. This is the self-contained K-of-N fallback used
///             until BI1 is deployed.
///         Admin can switch between the two via {setValidatorSet} / {setLocalQuorum}.
///
/// @dev Binds to:
///        - {WrappedEcosystemToken} (compute/WrappedEcosystemToken.sol): minted on deposit via its
///          custodian `mint(to,amount,originLockRef)`; the bridge must hold its `CUSTODIAN_ROLE`.
///        - {WrappedTokenFactory} (compute/WrappedTokenFactory.sol): the source of those wrappers —
///          its `wrappedOf[originRef]` is the off-chain map admin mirrors into {registerToken} here.
///        Withdrawals pull the wrapper in and burn it (it is {ERC20Burnable}), emitting
///        {GrapheneWithdrawal} for the off-chain relayer to release native MELEK on the source chain.
contract GrapheneDepositBridge is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Admin manages the token registry, validator-set wiring and quorum.
    bytes32 public constant ADMIN_ROLE = keccak256("BRIDGE_ADMIN_ROLE");
    /// @notice Built-in attester set (used only when `validatorSet == address(0)`).
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    /// @notice External federated validator set (BI1). address(0) ⇒ use the built-in ATTESTER_ROLE.
    IBridgeValidatorSet public validatorSet;

    /// @notice K threshold for the BUILT-IN attester set. Ignored when an external `validatorSet` is
    ///         configured (its `quorum()` is used instead). Must be >= 1 in built-in mode.
    uint256 public localQuorum;

    /// @notice ecosystemTokenId (e.g. the wrapper's originRef) => PRANA-side wrapped token address.
    ///         Admin mirrors {WrappedTokenFactory.wrappedOf} into here for the tokens this bridge
    ///         serves. Only registered ids can be deposited/withdrawn.
    mapping(bytes32 => address) public wrappedToken;

    /// @notice depositRef (Graphene tx id / sequence) => already minted. One mint per ref, ever.
    mapping(bytes32 => bool) public depositProcessed;

    struct Deposit {
        bytes32 tokenId; // ecosystem token id being minted
        address recipient; // PRANA address credited
        uint256 amount; // wrapped amount to mint
        uint256 count; // distinct attestations so far
        bool minted; // mint executed (terminal)
    }

    /// @notice depositRef => in-flight attestation tally.
    mapping(bytes32 => Deposit) private _deposits;
    /// @notice depositRef => attester => already attested (distinctness guard).
    mapping(bytes32 => mapping(address => bool)) private _attested;

    /// @notice Monotonic nonce for outbound withdrawals (gives the relayer a stable ordering key).
    uint256 public withdrawalNonce;

    // --- events ------------------------------------------------------------ //
    event ValidatorSetUpdated(address indexed validatorSet);
    event LocalQuorumUpdated(uint256 quorum);
    event TokenRegistered(bytes32 indexed tokenId, address indexed wrapped);
    event TokenUnregistered(bytes32 indexed tokenId, address indexed wrapped);
    event DepositAttested(
        bytes32 indexed depositRef,
        bytes32 indexed tokenId,
        address indexed attester,
        address recipient,
        uint256 amount,
        uint256 count,
        uint256 required
    );
    event DepositMinted(
        bytes32 indexed depositRef,
        bytes32 indexed tokenId,
        address indexed recipient,
        address wrapped,
        uint256 amount
    );
    event GrapheneWithdrawal(
        uint256 indexed nonce,
        bytes32 indexed tokenId,
        address indexed from,
        address wrapped,
        uint256 amount,
        bytes32 destinationRef
    );

    // --- errors ------------------------------------------------------------ //
    error ZeroAddress();
    error ZeroAmount();
    error ZeroRef();
    error TokenNotRegistered(bytes32 tokenId);
    error TokenAlreadyRegistered(bytes32 tokenId, address existing);
    error DepositAlreadyProcessed(bytes32 depositRef);
    error NotAnAttester(address account);
    error AlreadyAttested(bytes32 depositRef, address attester);
    error AttestationMismatch(bytes32 depositRef);
    error BadQuorum();
    error NoQuorumConfigured();

    /// @param admin_  Receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE (manages registry, set, quorum).
    /// @param validatorSet_ Optional external {IBridgeValidatorSet} (BI1). Pass address(0) to start
    ///                      in built-in ATTESTER_ROLE mode (then grant roles + {setLocalQuorum}).
    constructor(address admin_, address validatorSet_) {
        if (admin_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        // ADMIN_ROLE also administers the built-in ATTESTER_ROLE set.
        _setRoleAdmin(ATTESTER_ROLE, ADMIN_ROLE);
        if (validatorSet_ != address(0)) {
            validatorSet = IBridgeValidatorSet(validatorSet_);
            emit ValidatorSetUpdated(validatorSet_);
        }
    }

    // ===================================================================== //
    //                              ADMIN
    // ===================================================================== //

    /// @notice Point the bridge at an external federated validator set, or clear it (address(0)) to
    ///         fall back to the built-in ATTESTER_ROLE + {localQuorum} set.
    function setValidatorSet(address validatorSet_) external onlyRole(ADMIN_ROLE) {
        validatorSet = IBridgeValidatorSet(validatorSet_);
        emit ValidatorSetUpdated(validatorSet_);
    }

    /// @notice Set K for the built-in attester set. Has no effect while an external set is wired.
    function setLocalQuorum(uint256 quorum_) external onlyRole(ADMIN_ROLE) {
        if (quorum_ == 0) revert BadQuorum();
        localQuorum = quorum_;
        emit LocalQuorumUpdated(quorum_);
    }

    /// @notice Register the PRANA-side wrapper for an ecosystem token id (mirror of
    ///         {WrappedTokenFactory.wrappedOf}). One wrapper per id; re-register is rejected.
    function registerToken(bytes32 tokenId, address wrapped) external onlyRole(ADMIN_ROLE) {
        if (tokenId == bytes32(0)) revert ZeroRef();
        if (wrapped == address(0)) revert ZeroAddress();
        address existing = wrappedToken[tokenId];
        if (existing != address(0)) revert TokenAlreadyRegistered(tokenId, existing);
        wrappedToken[tokenId] = wrapped;
        emit TokenRegistered(tokenId, wrapped);
    }

    /// @notice Stop serving an ecosystem token id (e.g. on wrapper rotation). In-flight refs for the
    ///         id can no longer mint; existing minted supply is unaffected.
    function unregisterToken(bytes32 tokenId) external onlyRole(ADMIN_ROLE) {
        address existing = wrappedToken[tokenId];
        if (existing == address(0)) revert TokenNotRegistered(tokenId);
        delete wrappedToken[tokenId];
        emit TokenUnregistered(tokenId, existing);
    }

    // ===================================================================== //
    //                      INBOUND: Graphene deposit -> mint
    // ===================================================================== //

    /// @notice A federated attester reports a Graphene/Hive-Engine deposit. Once K distinct active
    ///         attesters report the SAME (tokenId, recipient, amount) under `depositRef`, the matching
    ///         wrapper is minted to `recipient` exactly once.
    /// @param depositRef Graphene tx id / sequence — globally unique per deposit (the replay key).
    /// @param tokenId    Registered ecosystem token id (wrapper originRef).
    /// @param recipient  PRANA address to credit.
    /// @param amount     Wrapped amount to mint (1:1 with the native deposit, matching decimals).
    function attestDeposit(
        bytes32 depositRef,
        bytes32 tokenId,
        address recipient,
        uint256 amount
    ) external nonReentrant {
        if (depositRef == bytes32(0)) revert ZeroRef();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (depositProcessed[depositRef]) revert DepositAlreadyProcessed(depositRef);

        address wrapped = wrappedToken[tokenId];
        if (wrapped == address(0)) revert TokenNotRegistered(tokenId);

        _requireAttester(msg.sender);
        if (_attested[depositRef][msg.sender]) revert AlreadyAttested(depositRef, msg.sender);

        Deposit storage d = _deposits[depositRef];
        if (d.count == 0) {
            // First attestation defines the (tokenId, recipient, amount) tuple for this ref.
            d.tokenId = tokenId;
            d.recipient = recipient;
            d.amount = amount;
        } else {
            // Subsequent attesters must agree on the exact same tuple, else they are attesting a
            // different deposit and must not be tallied together.
            if (d.tokenId != tokenId || d.recipient != recipient || d.amount != amount) {
                revert AttestationMismatch(depositRef);
            }
        }

        _attested[depositRef][msg.sender] = true;
        uint256 count = d.count + 1;
        d.count = count;

        uint256 required = _quorum();
        emit DepositAttested(depositRef, tokenId, msg.sender, recipient, amount, count, required);

        if (count >= required && !d.minted) {
            d.minted = true;
            depositProcessed[depositRef] = true;
            IWrappedEcosystemTokenMint(wrapped).mint(recipient, amount, depositRef);
            emit DepositMinted(depositRef, tokenId, recipient, wrapped, amount);
        }
    }

    // ===================================================================== //
    //                      OUTBOUND: burn -> Graphene release
    // ===================================================================== //

    /// @notice Burn registered wrapped supply to withdraw native MELEK back on the Graphene chain.
    ///         Pulls `amount` of the wrapper from the caller, burns it, and emits {GrapheneWithdrawal}
    ///         which the off-chain relayer watches to release native funds to `destinationRef`.
    /// @param tokenId        Registered ecosystem token id.
    /// @param amount         Wrapped amount to burn / withdraw.
    /// @param destinationRef Opaque encoding of the Graphene-side destination account.
    /// @return nonce         Outbound ordering nonce for the relayer.
    function withdraw(bytes32 tokenId, uint256 amount, bytes32 destinationRef)
        external
        nonReentrant
        returns (uint256 nonce)
    {
        if (amount == 0) revert ZeroAmount();
        address wrapped = wrappedToken[tokenId];
        if (wrapped == address(0)) revert TokenNotRegistered(tokenId);

        nonce = withdrawalNonce++;
        // Pull the wrapper in, then burn this bridge's own balance. The wrapper is {ERC20Burnable};
        // burning our own held balance keeps the burn independent of any allowance edge cases.
        IERC20(wrapped).safeTransferFrom(msg.sender, address(this), amount);
        IBurnable(wrapped).burn(amount);

        emit GrapheneWithdrawal(nonce, tokenId, msg.sender, wrapped, amount, destinationRef);
    }

    // ===================================================================== //
    //                               VIEWS
    // ===================================================================== //

    /// @notice Whether `account` is an active attester under the currently-configured set.
    function isAttester(address account) public view returns (bool) {
        IBridgeValidatorSet vs = validatorSet;
        if (address(vs) != address(0)) return vs.isValidator(account);
        return hasRole(ATTESTER_ROLE, account);
    }

    /// @notice The current K threshold under the configured set (external `quorum()` or `localQuorum`).
    function requiredQuorum() external view returns (uint256) {
        return _quorum();
    }

    /// @notice In-flight tally for a deposit ref: (tokenId, recipient, amount, count, minted).
    function depositStatus(bytes32 depositRef)
        external
        view
        returns (bytes32 tokenId, address recipient, uint256 amount, uint256 count, bool minted)
    {
        Deposit storage d = _deposits[depositRef];
        return (d.tokenId, d.recipient, d.amount, d.count, d.minted);
    }

    /// @notice Whether `attester` has already attested `depositRef`.
    function hasAttested(bytes32 depositRef, address attester) external view returns (bool) {
        return _attested[depositRef][attester];
    }

    // ===================================================================== //
    //                              INTERNAL
    // ===================================================================== //

    function _requireAttester(address account) internal view {
        if (!isAttester(account)) revert NotAnAttester(account);
    }

    /// @dev External validator set's `quorum()` if wired, else the built-in `localQuorum`. Reverts if
    ///      neither yields a usable (>0) threshold so a deposit can never auto-mint on a single
    ///      attestation by accident.
    function _quorum() internal view returns (uint256 q) {
        IBridgeValidatorSet vs = validatorSet;
        q = address(vs) != address(0) ? vs.quorum() : localQuorum;
        if (q == 0) revert NoQuorumConfigured();
    }
}

/// @dev Minimal burn surface ({ERC20Burnable-burn}) used by the withdraw path.
interface IBurnable {
    function burn(uint256 amount) external;
}
