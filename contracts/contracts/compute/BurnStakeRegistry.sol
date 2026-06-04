// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBurnStakeRegistry} from "../interfaces/IBurnStakeRegistry.sol";

/// @notice Minimal surface of the {ProofOfBurnRegistry} append-only receipt ledger this registry
///         optionally notifies. The receipt registry burns via `burnFrom` (needs an approval), so
///         the notification path is a SEPARATE burn from the one this contract performs — we only
///         wire it when the deployer wants the generic public receipt as well. See {setReceiptLedger}.
interface IProofOfBurnReceipts {
    function recordBurn(ERC20Burnable token, uint256 amount, bytes32 ref) external returns (uint256 id);
}

/// @title BurnStakeRegistry — Proof-of-Burn PERMA-stake ledger (the capture-resistant third lane).
/// @notice Burning a token records a PERMANENT, non-withdrawable stake-weight ∝ amount burned.
///
/// @dev IRREVERSIBILITY IS THE DESIGN — disclosed plainly:
///      A burn here is a one-way door. The principal is destroyed (sent to `address(0)` / `burn`),
///      and the credited weight is a forever ledger entry. There is **NO** function on this contract
///      that decreases {weightOf}, decreases {totalWeight}, or returns principal — not for the owner,
///      not for an admin, not for the burner. `weightOf` is monotonically non-decreasing for every
///      account. This is intentional and load-bearing:
///        * It is the THIRD governance/emission lane (alongside live balance and time-decay ve-lock)
///          that **cannot be borrowed or flash-loaned**. There is no transfer, no withdraw, and no
///          unlock, so the Steem/Justin-Sun "rent a majority of stake for one block, vote, give it
///          back" takeover is structurally impossible here — you can only get weight by *permanently
///          destroying value*, which no lender will front.
///        * Because weight only ever grows, downstream consumers (the unified shares ledger's BURN
///          lane and the governance adapter) can treat it as an append-only accumulator.
///
///      TWO DOORS into the ledger:
///        1. {recordBurnWeight} — gated to {BURNER_ROLE} (the MultiCurrencyBurnRouter sibling). The
///           router accepts arbitrary whitelisted currencies, performs the burn itself, normalizes
///           the cross-currency amount to a common weight unit, then records the weight here. This
///           contract trusts the router's normalization (it is the role holder).
///        2. {burnPrana} — the simple single-currency door. Anyone may pull+burn native PRANA
///           (an {ERC20Burnable}) straight through this contract and self-credit weight 1:1, so the
///           registry is fully functional for native PRANA WITHOUT the router being deployed.
contract BurnStakeRegistry is IBurnStakeRegistry, AccessControl {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to credit weight for already-burned / router-normalized cross-currency
    ///         burns via {recordBurnWeight}. Held by the MultiCurrencyBurnRouter.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    /// @notice Role allowed to wire the optional {ProofOfBurnRegistry} receipt ledger.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice The native PRANA token, burned 1:1 for weight via {burnPrana}.
    ERC20Burnable public immutable prana;

    /// @inheritdoc IBurnStakeRegistry
    mapping(address => uint256) public weightOf;
    /// @inheritdoc IBurnStakeRegistry
    uint256 public totalWeight;

    /// @notice Optional public receipt ledger notified on each burn (0 = disabled). Append-only ref.
    IProofOfBurnReceipts public receiptLedger;

    /// @notice Optional governance adapter hook auto-checkpointed on each weight credit (0 = disabled).
    IBurnStakeWeightHook public weightHook;

    error ZeroAmount();
    error ZeroAddress();

    /// @notice Emitted when the optional receipt-ledger pointer changes.
    event ReceiptLedgerSet(address indexed ledger);
    /// @notice Emitted when the optional governance-adapter weight hook changes.
    event WeightHookSet(address indexed hook);

    /// @param prana_ The native PRANA token (ERC20Burnable) used by {burnPrana}.
    /// @param admin  Receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE (wiring + role grants).
    constructor(ERC20Burnable prana_, address admin) {
        if (address(prana_) == address(0) || admin == address(0)) revert ZeroAddress();
        prana = prana_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------
    // Weight crediting — both doors funnel through _credit, which is the ONLY writer of weight.
    // There is deliberately no _debit: weight is permanent.
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IBurnStakeRegistry
    /// @dev BURNER_ROLE gate. `amount` is the raw burned amount of `token` (for the receipt/event);
    ///      `weightAdded` is the router's cross-currency-normalized weight to credit. The router is
    ///      responsible for having ALREADY burned `amount` of `token` before calling — this function
    ///      records the resulting permanent weight; it does not itself move or burn `token`.
    function recordBurnWeight(address account, address token, uint256 amount, uint256 weightAdded)
        external
        onlyRole(BURNER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (weightAdded == 0) revert ZeroAmount();
        _credit(account, token, amount, weightAdded);
    }

    /// @notice The simple single-currency door: pull+burn `amount` of native PRANA from the caller
    ///         and self-credit permanent weight 1:1.
    /// @dev No role required (anyone may permanently destroy their own PRANA for weight). The caller
    ///      must `approve` this contract for `amount` first. The PRANA is irreversibly burned.
    /// @return weightAdded The weight credited (== `amount`, 1:1).
    function burnPrana(uint256 amount) external returns (uint256 weightAdded) {
        if (amount == 0) revert ZeroAmount();
        // Pull then burn from this contract's own balance (ERC20Burnable.burn), so we never need a
        // burnFrom allowance race and the principal is provably destroyed here.
        IERC20(address(prana)).safeTransferFrom(msg.sender, address(this), amount);
        prana.burn(amount);
        weightAdded = amount;
        _credit(msg.sender, address(prana), amount, weightAdded);
    }

    /// @dev The single weight writer. Monotonic: only ever INCREASES `weightOf`/`totalWeight`.
    function _credit(address account, address token, uint256 amount, uint256 weightAdded) internal {
        weightOf[account] += weightAdded;
        totalWeight += weightAdded;

        emit Burned(account, token, amount, weightAdded);

        // Auto-checkpoint the governance adapter so getPastVotes history stays current without the
        // account having to remember to call checkpoint() itself (see BurnStakeGovernanceAdapter).
        if (address(weightHook) != address(0)) {
            weightHook.onWeightCredited(account, weightOf[account], totalWeight);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Optional public proof-of-burn receipt
    // ------------------------------------------------------------------------------------------
    // NOTE on the receipt ledger: {ProofOfBurnRegistry.recordBurn} performs its OWN `burnFrom`, i.e.
    // it expects to burn the principal itself. In THIS contract the principal is ALWAYS already burned
    // by the time weight is credited (burnPrana burns inline; the router burns before calling
    // recordBurnWeight), so we cannot route the same principal through the receipt ledger a second
    // time. The `receiptLedger` pointer is therefore exposed as a documented, integrator-readable
    // reference (and for a router that wants to emit a separate, independently-funded receipt) rather
    // than auto-invoked here — auto-invoking would attempt a double burn and revert. Weight crediting
    // is the source of truth; the public receipt is an optional, separate concern.

    // ------------------------------------------------------------------------------------------
    // Wiring (admin)
    // ------------------------------------------------------------------------------------------

    /// @notice Wire (or clear, with 0) the optional governance-adapter weight hook.
    function setWeightHook(IBurnStakeWeightHook hook) external onlyRole(ADMIN_ROLE) {
        weightHook = hook;
        emit WeightHookSet(address(hook));
    }

    /// @notice Wire (or clear, with 0) the optional public {ProofOfBurnRegistry} receipt ledger.
    function setReceiptLedger(IProofOfBurnReceipts ledger) external onlyRole(ADMIN_ROLE) {
        receiptLedger = ledger;
        emit ReceiptLedgerSet(address(ledger));
    }
}

/// @notice Auto-checkpoint hook the registry calls on every weight credit. Implemented by
///         {BurnStakeGovernanceAdapter} so vote history is recorded at the block weight changed,
///         with no separate user action required.
interface IBurnStakeWeightHook {
    function onWeightCredited(address account, uint256 newWeight, uint256 newTotalWeight) external;
}
