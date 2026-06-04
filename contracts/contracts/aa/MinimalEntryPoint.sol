// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PackedUserOperation, UserOperationLib} from "./PackedUserOperation.sol";

/// @notice The minimal account interface the harness calls (subset of v0.7 IAccount).
interface IAccount {
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}

/// @notice The minimal paymaster interface the harness calls (subset of v0.7 IPaymaster).
///         The harness ignores the returned `context` and never calls postOp (simplified).
interface IPaymaster {
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData);
}

/// @title MinimalEntryPoint — a TEST-HARNESS ERC-4337 v0.7 entry point (NOT production)
/// @notice Stands in for the canonical EntryPoint so the AA stack can be exercised on a dev
///         chain with no bundler. It speaks the v0.7 interfaces (PackedUserOperation,
///         validateUserOp / validatePaymasterUserOp returning packed `validationData`,
///         deposit-backed prefund, per-(sender,key) nonces) so a canonical EntryPoint can
///         replace it later with no changes to the account or paymaster.
/// @dev    SIMPLIFICATIONS vs the real v0.7 EntryPoint (all deliberate, all here):
///         1. GAS MARKET IS FLAT. There is no real metering, no EIP-1559 priority math, no
///            refund of unused gas. Each op is charged a single flat `prefund` amount that the
///            caller of `handleOps` supplies per op (see HandleOpsArgs.prefund). `maxCost`
///            passed to validation == that flat prefund.
///         2. NO postOp / context. The paymaster's returned context is discarded and postOp
///            is never called. (The real EntryPoint runs postOp to settle actual gas.)
///         3. NO innerHandleOp try/catch isolation or gas-griefing protections; a reverting
///            account call reverts the whole op (FailedOp) rather than being caught per-op.
///         4. NO account deployment from initCode (factory create happens in tests directly).
///         5. validationData time-range + sigFail are honored exactly (this is the part we
///            keep faithful): aggregator field is ignored (must be 0 or the sig-fail sentinel).
contract MinimalEntryPoint {
    using UserOperationLib for PackedUserOperation;

    /// @dev v0.7 sentinel: validateUserOp/validatePaymaster returns 1 in the low 160 bits
    ///      (aggregator slot) to signal signature failure.
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    /// @notice Native deposit backing prefunds, keyed by account or paymaster address.
    mapping(address => uint256) public deposits;

    /// @notice Nonce sequence per (account, key). v0.7 nonce = (key << 64) | sequence.
    mapping(address => mapping(uint192 => uint64)) public nonceSequence;

    struct HandleOpsArgs {
        PackedUserOperation op;
        /// @dev flat prefund charged for this op (stand-in for real gas cost).
        uint256 prefund;
    }

    event Deposited(address indexed account, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        uint256 actualCost
    );
    event BeneficiaryPaid(address indexed beneficiary, uint256 amount);

    error ZeroAmount();
    error InsufficientDeposit(address account, uint256 available, uint256 required);
    error WithdrawFailed();
    error InvalidBeneficiary();
    /// @dev v0.7-style validation failure. `reason` is a short code, e.g. "AA22" (expired/not
    ///      due), "AA24" (signature error), "AA23" (account validation reverted),
    ///      "AA34" (paymaster signature error), "AA31" (paymaster deposit too low),
    ///      "AA25" (invalid account nonce).
    error FailedOp(uint256 opIndex, string reason);

    // ---------------------------------------------------------------------
    // Deposit accounting (flat, no gas market)
    // ---------------------------------------------------------------------

    /// @notice Deposit native value to prefund ops for `account` (account or paymaster).
    function depositTo(address account) public payable {
        if (msg.value == 0) revert ZeroAmount();
        deposits[account] += msg.value;
        emit Deposited(account, msg.value, deposits[account]);
    }

    /// @notice Bare transfers credit the sender's own deposit.
    receive() external payable {
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, deposits[msg.sender]);
    }

    /// @notice Withdraw caller's own deposit.
    function withdrawTo(address payable to, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = deposits[msg.sender];
        if (bal < amount) revert InsufficientDeposit(msg.sender, bal, amount);
        deposits[msg.sender] = bal - amount;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(msg.sender, to, amount);
    }

    function balanceOf(address account) external view returns (uint256) {
        return deposits[account];
    }

    // ---------------------------------------------------------------------
    // Nonce management: v0.7 (key << 64) | sequence
    // ---------------------------------------------------------------------

    /// @notice The next valid full nonce for (sender, key).
    function getNonce(address sender, uint192 key) external view returns (uint256) {
        return (uint256(key) << 64) | nonceSequence[sender][key];
    }

    function _validateAndBumpNonce(address sender, uint256 nonce) internal returns (bool) {
        uint192 key = uint192(nonce >> 64);
        uint64 seq = uint64(nonce);
        if (nonceSequence[sender][key] != seq) return false;
        nonceSequence[sender][key] = seq + 1;
        return true;
    }

    // ---------------------------------------------------------------------
    // Op execution
    // ---------------------------------------------------------------------

    /// @notice Run a batch of ops: validate, charge prefund, execute, pay beneficiary.
    /// @param args  one entry per op, each carrying the op and its flat prefund.
    /// @param beneficiary  receives the sum of charged prefunds (the "bundler").
    function handleOps(HandleOpsArgs[] calldata args, address payable beneficiary) external {
        if (beneficiary == address(0)) revert InvalidBeneficiary();

        uint256 collected;
        for (uint256 i; i < args.length; ++i) {
            collected += _handleOp(i, args[i]);
        }

        (bool ok, ) = beneficiary.call{value: collected}("");
        if (!ok) revert WithdrawFailed();
        emit BeneficiaryPaid(beneficiary, collected);
    }

    /// @dev Validate one op (account + optional paymaster), charge the flat prefund to whoever
    ///      pays (paymaster if present, else the account), then execute the call.
    function _handleOp(uint256 i, HandleOpsArgs calldata a) internal returns (uint256 prefund) {
        PackedUserOperation calldata op = a.op;
        prefund = a.prefund;
        bytes32 opHash = op.userOpHash(address(this), block.chainid);

        // --- nonce (AA25) ---
        if (!_validateAndBumpNonce(op.sender, op.nonce)) {
            revert FailedOp(i, "AA25");
        }

        // --- who pays? paymaster (first 20 bytes of paymasterAndData) or the account ---
        address paymaster = _paymasterOf(op);

        // --- charge prefund from the payer's deposit up front ---
        address payer = paymaster == address(0) ? op.sender : paymaster;
        uint256 bal = deposits[payer];
        if (bal < prefund) {
            revert FailedOp(i, paymaster == address(0) ? "AA21" : "AA31");
        }
        deposits[payer] = bal - prefund;

        // --- account validation (AA23 revert / AA24 sig / AA22 time) ---
        // missingAccountFunds is 0 here: the entry point already debited the deposit, so the
        // account need not transfer anything (it may still no-op its prefund branch).
        uint256 accountValidationData = IAccount(op.sender).validateUserOp(op, opHash, 0);
        _requireValid(i, accountValidationData, "AA24", "AA22");

        // --- paymaster validation (AA34 sig / AA32 time) ---
        if (paymaster != address(0)) {
            (, uint256 pmValidationData) =
                IPaymaster(paymaster).validatePaymasterUserOp(op, opHash, prefund);
            _requireValid(i, pmValidationData, "AA34", "AA32");
        }

        // --- execute the account call ---
        (bool ok, bytes memory ret) = op.sender.call(op.callData);
        if (!ok) {
            // bubble up nothing fancy; harness surfaces a generic failure (real EP catches this)
            revert FailedOp(i, "AA23");
        }
        ret; // unused

        emit UserOperationEvent(opHash, op.sender, paymaster, op.nonce, prefund);
    }

    /// @dev Decode the packed `validationData` (sigAuthorizer | validUntil<<160 | validAfter<<208)
    ///      and revert with the right v0.7-style code on sig-fail or out-of-time-range.
    function _requireValid(
        uint256 i,
        uint256 validationData,
        string memory sigCode,
        string memory timeCode
    ) internal view {
        uint256 sigAuthorizer = uint160(validationData);
        if (sigAuthorizer == SIG_VALIDATION_FAILED) revert FailedOp(i, sigCode);

        uint48 validUntil = uint48(validationData >> 160);
        uint48 validAfter = uint48(validationData >> (160 + 48));
        // validUntil == 0 means "no expiry" (v0.7 convention).
        if (validUntil != 0 && block.timestamp > validUntil) revert FailedOp(i, timeCode);
        if (block.timestamp < validAfter) revert FailedOp(i, timeCode);
    }

    /// @dev First 20 bytes of paymasterAndData, or address(0) if none.
    function _paymasterOf(PackedUserOperation calldata op) internal pure returns (address) {
        if (op.paymasterAndData.length < 20) return address(0);
        return address(bytes20(op.paymasterAndData[0:20]));
    }
}
