// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal NFT minter surface the card payload can target for the NFT delivery kind.
///         Must grant this contract the minting role (e.g. MINTER_ROLE).
interface ICardNftMinter {
    function mint(address to, string calldata uri) external returns (uint256 id);
}

/// @title PhysicalCardRedemption — NFC/QR physical-to-digital claim bridge
/// @notice Cards are pre-printed off-chain with a `serial` (printed/visible) and a `secret`
///         (hidden under a scratch-off / inside the NFC chip). The admin batch-registers the
///         hiding commitment `keccak256(abi.encodePacked(serial, secret))` for every card in a
///         batch BEFORE the cards ship, so the chain never learns a secret until someone redeems.
///
///         At redeem time the holder supplies `(serial, secret, recipient)`; the contract
///         recomputes the commitment, checks it was registered to a (still-valid, not-yet-spent)
///         batch, marks it redeemed (double-redeem guard), and delivers that batch's payload:
///           - TOKEN: transfers `amountOrUri` units of an ERC-20 from this contract's funded pool.
///           - NFT:   calls `target.mint(recipient, uri)` via a minter role this contract holds.
///
///         Each batch carries an `expiry`. After expiry, registered-but-unredeemed cards can no
///         longer be redeemed, and the admin may `sweep` the batch's still-escrowed TOKEN funds
///         (the per-card amount times the count of cards that never redeemed) back to a treasury.
///
///         Trust model: whoever can read a card (serial + secret) can redeem it — exactly like a
///         scratch-off voucher. Physical custody of the card IS the bearer credential; the chain
///         only enforces single-use and batch policy. Keep secrets high-entropy off-chain.
contract PhysicalCardRedemption is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    enum PayloadKind {
        TOKEN,
        NFT
    }

    struct Batch {
        PayloadKind kind;
        address target; // ERC-20 (TOKEN) or NFT minter (NFT)
        uint256 amount; // per-card token amount (TOKEN kind); ignored for NFT
        string uri; // token URI minted per card (NFT kind); ignored for TOKEN
        uint64 expiry; // unix time after which cards can no longer redeem
        uint256 registered; // # commitments registered into this batch
        uint256 redeemed; // # commitments redeemed so far
        bool swept; // TOKEN escrow already swept after expiry
        bool exists;
    }

    /// @notice batchId => batch config + counters.
    mapping(uint256 => Batch) public batches;
    /// @notice commitment => batchId it belongs to (0-sentinel guarded by `commitmentSet`).
    mapping(bytes32 => uint256) public commitmentBatch;
    /// @notice commitment => registered at all.
    mapping(bytes32 => bool) public commitmentSet;
    /// @notice commitment => already redeemed.
    mapping(bytes32 => bool) public commitmentRedeemed;

    event RedeemableRegistered(uint256 indexed batch, uint256 count, uint256 totalRegistered);
    event BatchCreated(uint256 indexed batch, PayloadKind kind, address target, uint256 amount, uint64 expiry);
    event CardRedeemed(uint256 indexed batch, bytes32 indexed commitment, address indexed recipient);
    event BatchSwept(uint256 indexed batch, address indexed to, uint256 amount);
    event Funded(address indexed from, uint256 amount, address token);

    error ZeroAddress();
    error ZeroAmount();
    error BatchExists();
    error BatchUnknown();
    error WrongKind();
    error BadExpiry();
    error CommitmentAlreadyRegistered(bytes32 commitment);
    error CommitmentUnknown();
    error AlreadyRedeemed();
    error BatchExpired();
    error BatchNotExpired();
    error AlreadySwept();
    error PoolInsolvent(uint256 needed, uint256 balance);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                              Batch admin                              //
    // --------------------------------------------------------------------- //

    /// @notice Create a payload batch. For TOKEN batches fund this contract separately (the pool
    ///         is this contract's ERC-20 balance) so redemptions are backed by real escrow.
    /// @param batchId  caller-chosen unique id (reverts if already used)
    /// @param kind     TOKEN or NFT delivery
    /// @param target   ERC-20 token (TOKEN) or NFT minter contract (NFT)
    /// @param amount   per-card token amount (TOKEN); pass 0 for NFT
    /// @param uri      per-card token URI (NFT); pass "" for TOKEN
    /// @param expiry   unix time after which redemption closes
    function createBatch(
        uint256 batchId,
        PayloadKind kind,
        address target,
        uint256 amount,
        string calldata uri,
        uint64 expiry
    ) external onlyRole(ADMIN_ROLE) {
        if (batches[batchId].exists) revert BatchExists();
        if (target == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp) revert BadExpiry();
        if (kind == PayloadKind.TOKEN && amount == 0) revert ZeroAmount();

        Batch storage b = batches[batchId];
        b.kind = kind;
        b.target = target;
        b.amount = amount;
        b.uri = uri;
        b.expiry = expiry;
        b.exists = true;

        emit BatchCreated(batchId, kind, target, amount, expiry);
    }

    /// @notice Register a set of card commitments into an existing, unexpired batch.
    /// @dev    `commitments[i] == keccak256(abi.encodePacked(serial, secret))`, computed off-chain
    ///         when the cards are printed. Reverts on any duplicate so no commitment is ever
    ///         double-owned across batches.
    function registerCommitments(uint256 batchId, bytes32[] calldata commitments)
        external
        onlyRole(ADMIN_ROLE)
    {
        Batch storage b = batches[batchId];
        if (!b.exists) revert BatchUnknown();
        if (block.timestamp >= b.expiry) revert BatchExpired();

        uint256 len = commitments.length;
        for (uint256 i = 0; i < len; i++) {
            bytes32 c = commitments[i];
            if (commitmentSet[c]) revert CommitmentAlreadyRegistered(c);
            commitmentSet[c] = true;
            commitmentBatch[c] = batchId;
        }
        b.registered += len;

        emit RedeemableRegistered(batchId, len, b.registered);
    }

    // --------------------------------------------------------------------- //
    //                                Funding                                //
    // --------------------------------------------------------------------- //

    /// @notice Convenience: pull `amount` of `token` into the contract to back TOKEN batches.
    function fund(IERC20 token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount, address(token));
    }

    // --------------------------------------------------------------------- //
    //                                 Redeem                                //
    // --------------------------------------------------------------------- //

    /// @notice Redeem a physical card. Recomputes the commitment from `(serial, secret)`; the
    ///         secret never appears on-chain until this call.
    /// @param serial    printed/visible card serial
    /// @param secret    hidden card secret (scratch-off / NFC)
    /// @param recipient who receives the payload (the holder picks any address)
    function redeem(bytes32 serial, bytes32 secret, address recipient) external {
        if (recipient == address(0)) revert ZeroAddress();

        bytes32 commitment = keccak256(abi.encodePacked(serial, secret));
        if (!commitmentSet[commitment]) revert CommitmentUnknown();
        if (commitmentRedeemed[commitment]) revert AlreadyRedeemed();

        uint256 batchId = commitmentBatch[commitment];
        Batch storage b = batches[batchId];
        if (block.timestamp >= b.expiry) revert BatchExpired();

        // Effects (mark redeemed before any external interaction).
        commitmentRedeemed[commitment] = true;
        b.redeemed += 1;

        _deliver(b, recipient);

        emit CardRedeemed(batchId, commitment, recipient);
    }

    /// @dev Delivers the batch payload to `recipient`. Split out to keep `redeem` shallow.
    function _deliver(Batch storage b, address recipient) private {
        if (b.kind == PayloadKind.TOKEN) {
            IERC20 token = IERC20(b.target);
            uint256 bal = token.balanceOf(address(this));
            if (bal < b.amount) revert PoolInsolvent(b.amount, bal);
            token.safeTransfer(recipient, b.amount);
        } else {
            ICardNftMinter(b.target).mint(recipient, b.uri);
        }
    }

    // --------------------------------------------------------------------- //
    //                                 Sweep                                 //
    // --------------------------------------------------------------------- //

    /// @notice After a TOKEN batch's expiry, sweep the escrow that backs its unredeemed cards
    ///         back to `to`. Amount = per-card amount * (registered - redeemed). Idempotent-guarded
    ///         per batch via the `swept` flag so the same batch cannot be swept twice.
    function sweep(uint256 batchId, address to) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        Batch storage b = batches[batchId];
        if (!b.exists) revert BatchUnknown();
        if (b.kind != PayloadKind.TOKEN) revert WrongKind();
        if (block.timestamp < b.expiry) revert BatchNotExpired();
        if (b.swept) revert AlreadySwept();

        b.swept = true;
        uint256 unredeemed = b.registered - b.redeemed;
        uint256 amount = unredeemed * b.amount;

        IERC20 token = IERC20(b.target);
        uint256 bal = token.balanceOf(address(this));
        if (amount > bal) amount = bal; // never over-pull; pool may back multiple batches

        if (amount > 0) token.safeTransfer(to, amount);
        emit BatchSwept(batchId, to, amount);
    }

    // --------------------------------------------------------------------- //
    //                                 Views                                 //
    // --------------------------------------------------------------------- //

    /// @notice Helper mirroring the off-chain commitment derivation, for tooling/tests.
    function computeCommitment(bytes32 serial, bytes32 secret) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(serial, secret));
    }

    /// @notice True if a card commitment is still redeemable right now.
    function isRedeemable(bytes32 commitment) external view returns (bool) {
        if (!commitmentSet[commitment] || commitmentRedeemed[commitment]) return false;
        return block.timestamp < batches[commitmentBatch[commitment]].expiry;
    }
}
