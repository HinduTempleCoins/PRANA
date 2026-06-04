// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IBridgeValidatorSet} from "../interfaces/IBridgeValidatorSet.sol";

/// @notice Minimal mint authority this bridge needs on the wrapped token. A wrapped token wired to
///         this bridge MUST expose `mint(address,uint256)` gated to this bridge's address (e.g. via
///         a MINTER/CUSTODIAN role granted to this contract).
/// @dev    NOTE: {WrappedEcosystemToken.mint} takes a third `bytes32 originLockRef` argument, so it
///         does NOT satisfy this interface directly. Either (a) deploy that token with a thin
///         minter-adapter exposing `mint(to,amount)` that forwards a zero/derived ref, or (b) use a
///         plain mintable+burnable ERC-20 (the burn path here needs {IERC20Burnable.burn}). The
///         injected `wrapped` token must satisfy BOTH {IMintable} and {IERC20Burnable}.
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice The subset of {ERC20Burnable} this bridge uses for the withdrawal (burn) path.
interface IERC20Burnable {
    /// @notice Destroy `amount` from `from`, decreasing the caller's allowance from `from`.
    function burnFrom(address from, uint256 amount) external;
}

/// @title CanonicalLockMintBridge — the PRANA-side federated bridge endpoint (BI2)
///
/// @notice The upgrade of the single-custodian {PeggedBridgeVault} mint path to a K-of-N federated
///         trust model. Instead of ONE custodian calling `mintFromBridge`, ANYONE may submit a mint
///         carrying a bundle of validator signatures; the mint only succeeds if a quorum
///         ({IBridgeValidatorSet.threshold}) of DISTINCT validators signed the exact
///         `(to, amount, srcChainId, nonce)` message bound to THIS bridge instance.
///
///         FLOW (inbound, source-chain → PRANA):
///           1. A user locks/burns the canonical token on the SOURCE chain, emitting an event with
///              a unique `(srcChainId, nonce)`.
///           2. Off-chain validators observe that event and each sign the digest produced by
///              {hashMint} for `(to, amount, srcChainId, nonce)`.
///           3. A relayer collects >= K signatures and calls {mint}; the bridge verifies the quorum,
///              rejects a replayed `(srcChainId, nonce)`, and mints the wrapped token to `to`.
///
///         FLOW (outbound, PRANA → other chain):
///           - {burn} pulls and burns the user's wrapped supply (via {IERC20Burnable.burnFrom}) and
///             emits {Withdrawal} with a monotonically increasing `withdrawalNonce`. Validators on
///             the destination side observe this event and release/mint the canonical token there.
///
/// @dev REPLAY PROTECTION is per-`(srcChainId, nonce)` so two different source chains may reuse the
///      same numeric nonce without colliding. The signed digest also binds `block.chainid` (this
///      PRANA chain) and `address(this)` so signatures cannot be replayed onto another bridge
///      deployment or another chain. The validator set is queried live, so rotating/adding/removing
///      validators or changing the threshold immediately affects which signature bundles are valid.
///
///      TRUST MODEL: federated. Security rests on K-of-N validators being honest; a colluding
///      quorum can mint without a real source-chain lock. This is strictly stronger than the
///      stage-2 single custodian, and weaker than a trustless light-client bridge (the eventual
///      stage-3 target). The {PAUSER_ROLE} circuit-breaker bounds blast radius.
contract CanonicalLockMintBridge is AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Domain tag mixed into the mint digest to prevent cross-protocol signature reuse.
    bytes32 public constant MINT_TYPETAG = keccak256("CanonicalLockMintBridge.Mint.v1");

    /// @notice The K-of-N validator set gating inbound mints.
    IBridgeValidatorSet public immutable validatorSet;

    /// @notice The wrapped token this bridge mints (inbound) and burns (outbound). Must satisfy
    ///         {IMintable} and {IERC20Burnable}, and grant this bridge mint authority.
    address public immutable wrapped;

    /// @notice Per-(srcChainId, nonce) inbound replay guard. True once consumed by a {mint}.
    mapping(uint256 => mapping(uint256 => bool)) public processed;

    /// @notice Monotonic nonce for outbound withdrawal (burn) messages from this bridge.
    uint256 public withdrawalNonce;

    // --- events ------------------------------------------------------------ //
    event Minted(
        address indexed to,
        uint256 amount,
        uint256 indexed srcChainId,
        uint256 indexed nonce
    );
    event Withdrawal(
        uint256 indexed withdrawalNonce,
        address indexed from,
        uint256 indexed dstChainId,
        bytes32 dstAddr,
        uint256 amount
    );

    // --- errors ------------------------------------------------------------ //
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyProcessed(uint256 srcChainId, uint256 nonce);
    error QuorumNotMet();

    /// @param admin        receives DEFAULT_ADMIN_ROLE + PAUSER_ROLE (the DAO / timelock).
    /// @param validatorSet_ the federated K-of-N validator set.
    /// @param wrapped_      the wrapped token (mintable + burnable; grants this bridge mint rights).
    constructor(address admin, IBridgeValidatorSet validatorSet_, address wrapped_) {
        if (admin == address(0) || address(validatorSet_) == address(0) || wrapped_ == address(0)) {
            revert ZeroAddress();
        }
        validatorSet = validatorSet_;
        wrapped = wrapped_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ===================================================================== //
    //                              Pause control                            //
    // ===================================================================== //

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ===================================================================== //
    //                                 Views                                 //
    // ===================================================================== //

    /// @notice The raw 32-byte message that validators sign for an inbound mint. Binds the action
    ///         to THIS bridge (`address(this)`) and THIS chain (`block.chainid`) so signatures
    ///         cannot be replayed across bridges/chains.
    /// @dev    Validators sign the EIP-191 prefixed form of this digest (personal_sign /
    ///         ethers `signMessage(getBytes(digest))`); {IBridgeValidatorSet.verifySignatures}
    ///         applies the prefix on-chain.
    function hashMint(address to, uint256 amount, uint256 srcChainId, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                MINT_TYPETAG,
                block.chainid,
                address(this),
                to,
                amount,
                srcChainId,
                nonce
            )
        );
    }

    // ===================================================================== //
    //                         Inbound: src chain → PRANA                    //
    // ===================================================================== //

    /// @notice Mint wrapped supply to `to`, gated by a K-of-N validator quorum over the
    ///         `(to, amount, srcChainId, nonce)` message. Callable by anyone (a relayer) — security
    ///         comes from the signatures, not the caller.
    /// @param sigs validator signatures over {hashMint}'s digest; must include >= threshold from
    ///        DISTINCT current validators.
    function mint(
        address to,
        uint256 amount,
        uint256 srcChainId,
        uint256 nonce,
        bytes[] calldata sigs
    ) external whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (processed[srcChainId][nonce]) revert AlreadyProcessed(srcChainId, nonce);

        bytes32 digest = hashMint(to, amount, srcChainId, nonce);
        if (!validatorSet.verifySignatures(digest, sigs)) revert QuorumNotMet();

        // Effects before interaction (replay guard set prior to mint).
        processed[srcChainId][nonce] = true;

        IMintable(wrapped).mint(to, amount);

        emit Minted(to, amount, srcChainId, nonce);
    }

    // ===================================================================== //
    //                         Outbound: PRANA → dst chain                   //
    // ===================================================================== //

    /// @notice Burn the caller's wrapped supply and emit a {Withdrawal} for relayers to fulfil on
    ///         the destination chain. Requires the caller to have approved this bridge to burn
    ///         `amount` (standard ERC20 allowance, consumed by {IERC20Burnable.burnFrom}).
    /// @param dstChainId the destination chain the relayer should release/mint on.
    /// @param dstAddr    opaque encoding of the recipient on the destination chain (e.g. a 20-byte
    ///                   EVM address left-padded into bytes32, or a non-EVM address hash).
    function burn(uint256 amount, uint256 dstChainId, bytes32 dstAddr)
        external
        whenNotPaused
        returns (uint256 nonce)
    {
        if (amount == 0) revert ZeroAmount();

        nonce = withdrawalNonce++;

        // Burn from the user directly (consumes their allowance to this bridge). Reverts on
        // insufficient balance/allowance — no value can be created.
        IERC20Burnable(wrapped).burnFrom(msg.sender, amount);

        emit Withdrawal(nonce, msg.sender, dstChainId, dstAddr, amount);
    }
}
