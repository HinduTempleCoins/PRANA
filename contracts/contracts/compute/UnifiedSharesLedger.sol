// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IUnifiedSharesLedger} from "../interfaces/IUnifiedSharesLedger.sol";
import {IHashTaskWeightConfig} from "../interfaces/IHashTaskWeightConfig.sol";
import {EpochManager} from "./EpochManager.sol";

/// @dev Minimal surface of the optional Hathor SettlementFeeHook. When wired, the fee is taken
///      INLINE at payout (so every coordinator/own-pool pays it identically — there is no
///      front-end to route around). settle() pulls the fee to the treasury and the net to the
///      payee from this ledger's balance via transferFrom, returning the net paid.
interface ISettlementFeeHook {
    function settle(IERC20 token, address payee, uint256 amount) external returns (uint256 net);
}

/// @title UnifiedSharesLedger (NN1) — "the chain IS the pool" PPLNS ledger.
/// @notice One canonical mining pool, pinned to the chain. THREE lanes credit shares into the SAME
///         per-epoch pool and are paid pro-rata from a fixed per-epoch PRANA issuance over a rolling
///         PPLNS window:
///           - HASH  : the microhash-heartbeat (Ethash-style) lane (HASH_CREDITOR).
///           - TASK  : the AI-tasking / useful-work lane (TASK_CREDITOR).
///           - BURN  : the proof-of-burn perma-stake lane (BURN_CREDITOR).
///         By default HASH and TASK weights are equal (the "switching engine" — a hashed share and a
///         tasked share earn identically). Each lane has its OWN creditor role so an off-chain
///         coordinator / on-chain module can only credit the lane it is authorized for.
///
/// @dev PPLNS window/payout math (the exact formula implemented):
///        Let W   = windowEpochs (trailing # of epochs, EpochManager.windowBounds).
///        Let E   = the CLOSED epoch being claimed.
///        Window  = [start, E] where (start, E) = EpochManager.windowBounds(E, W)
///                  i.e. start = max(0, E - W + 1).
///        acctWin = Σ_{e=start..E}  poolShares[e][account]
///        totWin  = Σ_{e=start..E}  totalPoolShares[e]
///        payout(account, E) = epochIssuance * acctWin / totWin        (0 if totWin == 0)
///      Each (lane-native) credited `amount` is first scaled by the governed lane weight:
///        poolShares += amount * laneWeight(lane) / 1e18.
///      Payout is per CLOSED epoch and idempotent per (account, epoch) via a claimed bitmap.
///
/// @dev FUNDING / ISSUANCE: payouts are made from a held PRANA balance inside this contract. Two
///      supply paths, both crediting the same `totalFunded` budget that backs every payout:
///        1. fundEpoch(amount) — a FUNDER_ROLE holder (the EmissionScheduler, a MINTER, or a
///           treasury keeper) transfers `amount` PRANA in. SafeERC20 pull.
///        2. TODO(genesis-coinbase wiring): on a chain we own from genesis, the block coinbase
///           reward can be routed to this contract (a precompile / system-contract hook deposits
///           the per-block subsidy here) so issuance is truly chain-native rather than minted by a
///           role. Until that hook exists, fundEpoch() is the funding path. `epochIssuance` is the
///           fixed per-epoch payout target and is set by ISSUANCE_ADMIN_ROLE.
contract UnifiedSharesLedger is IUnifiedSharesLedger, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Per-lane creditor roles — an actor may only credit the lane it holds the role for.
    bytes32 public constant HASH_CREDITOR = keccak256("HASH_CREDITOR");
    bytes32 public constant TASK_CREDITOR = keccak256("TASK_CREDITOR");
    bytes32 public constant BURN_CREDITOR = keccak256("BURN_CREDITOR");

    /// @notice May fund the issuance budget (EmissionScheduler / treasury / coinbase keeper).
    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");
    /// @notice May set the fixed per-epoch issuance (the DAO timelock in production).
    bytes32 public constant ISSUANCE_ADMIN_ROLE = keccak256("ISSUANCE_ADMIN_ROLE");

    /// @notice Optional Hathor settlement-fee hook. address(0) (default) = no fee, pay in full.
    ///         When set, claim() routes the payout through it so the fee is taken inline at
    ///         settlement (every coordinator pays it; nothing can route around it).
    address public feeHook;

    event FeeHookSet(address indexed hook);

    /// @notice Wire (or clear) the settlement-fee hook. DAO/admin only.
    function setFeeHook(address hook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeHook = hook;
        emit FeeHookSet(hook);
    }

    uint256 private constant WEIGHT_ONE = 1e18;

    /// @notice The native PRANA token paid out (18-dec; wei under the hood, symbol PRANA on the wire).
    IERC20 public immutable prana;

    /// @notice Governed lane weights (pooling multipliers, 1e18 = 1x).
    IHashTaskWeightConfig public immutable weightConfig;

    /// @notice Fixed epoch length (seconds) — every compute-stack contract shares this via EpochManager.
    uint256 public immutable override epochLength;

    /// @notice Trailing PPLNS window width, in epochs.
    uint256 public override windowEpochs;

    /// @notice Fixed PRANA paid out per CLOSED epoch (split pro-rata across the window's shares).
    uint256 public override epochIssuance;

    /// @dev epoch => account => pooled (weight-applied) shares credited IN that epoch.
    mapping(uint256 => mapping(address => uint256)) public poolShares;
    /// @dev epoch => total pooled shares credited IN that epoch.
    mapping(uint256 => uint256) public totalPoolShares;
    /// @dev epoch => account => already claimed (idempotency bitmap).
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice Total PRANA pulled in as issuance budget.
    uint256 public totalFunded;
    /// @notice Total PRANA paid out via claim().
    uint256 public totalPaid;

    event WindowEpochsSet(uint256 windowEpochs);
    event EpochIssuanceSet(uint256 epochIssuance);
    event EpochFunded(address indexed funder, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroEpochLength();
    error ZeroWindow();
    error EpochNotClosed(uint256 epoch);
    error AlreadyClaimed(uint256 epoch, address account);
    error InsufficientFunds(uint256 requested, uint256 available);

    /// @param prana_         native PRANA token (payout asset).
    /// @param weightConfig_  the governed lane-weight config (NN5).
    /// @param admin          DEFAULT_ADMIN_ROLE + ISSUANCE_ADMIN_ROLE holder (DAO timelock in prod).
    /// @param epochLength_   fixed epoch length in seconds (> 0).
    /// @param windowEpochs_  trailing PPLNS window width in epochs (> 0).
    /// @param epochIssuance_ fixed PRANA per closed epoch (may be 0 at deploy, set later).
    constructor(
        IERC20 prana_,
        IHashTaskWeightConfig weightConfig_,
        address admin,
        uint256 epochLength_,
        uint256 windowEpochs_,
        uint256 epochIssuance_
    ) {
        if (address(prana_) == address(0) || address(weightConfig_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        if (epochLength_ == 0) revert ZeroEpochLength();
        if (windowEpochs_ == 0) revert ZeroWindow();

        prana = prana_;
        weightConfig = weightConfig_;
        epochLength = epochLength_;
        windowEpochs = windowEpochs_;
        epochIssuance = epochIssuance_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUANCE_ADMIN_ROLE, admin);

        emit WindowEpochsSet(windowEpochs_);
        emit EpochIssuanceSet(epochIssuance_);
    }

    // --------------------------------------------------------------------- //
    //                              crediting                                //
    // --------------------------------------------------------------------- //

    /// @inheritdoc IUnifiedSharesLedger
    function creditShares(address account, Lane lane, uint256 amount) external {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _requireLaneCreditor(lane);

        // Apply the governed lane weight: a lane-native share count -> pooled shares.
        uint256 pooled = (amount * weightConfig.laneWeight(lane)) / WEIGHT_ONE;
        if (pooled == 0) revert ZeroAmount(); // weight rounded the credit to nothing

        uint256 e = EpochManager.currentEpoch(epochLength);
        poolShares[e][account] += pooled;
        totalPoolShares[e] += pooled;

        emit SharesCredited(e, lane, account, amount);
    }

    function _requireLaneCreditor(Lane lane) internal view {
        bytes32 role = lane == Lane.HASH ? HASH_CREDITOR : (lane == Lane.TASK ? TASK_CREDITOR : BURN_CREDITOR);
        _checkRole(role);
    }

    // --------------------------------------------------------------------- //
    //                                claim                                   //
    // --------------------------------------------------------------------- //

    /// @inheritdoc IUnifiedSharesLedger
    function claim(uint256 epoch) external nonReentrant returns (uint256 paid) {
        if (!EpochManager.isEpochClosed(epoch, epochLength)) revert EpochNotClosed(epoch);
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed(epoch, msg.sender);

        paid = _payout(msg.sender, epoch);

        // Mark claimed BEFORE any external interaction (and even for a 0 payout, so the slot is final).
        claimed[epoch][msg.sender] = true;

        if (paid > 0) {
            uint256 available = totalFunded - totalPaid;
            if (paid > available) revert InsufficientFunds(paid, available);
            totalPaid += paid;
            address hook = feeHook;
            if (hook == address(0)) {
                // No fee configured → pay the full amount directly (default).
                prana.safeTransfer(msg.sender, paid);
            } else {
                // Settlement-level fee: the hook pulls fee→treasury and net→claimant from this
                // ledger via transferFrom, so every coordinator/own-pool pays it identically.
                prana.forceApprove(hook, paid);
                ISettlementFeeHook(hook).settle(prana, msg.sender, paid);
            }
        }

        emit Claimed(msg.sender, epoch, paid);
    }

    // --------------------------------------------------------------------- //
    //                              funding                                   //
    // --------------------------------------------------------------------- //

    /// @notice Fund the issuance budget that backs payouts (pull `amount` PRANA in).
    /// @dev FUNDER_ROLE: the EmissionScheduler, treasury, or coinbase keeper. See the genesis-coinbase
    ///      TODO in the contract header for the eventual chain-native deposit path.
    function fundEpoch(uint256 amount) external onlyRole(FUNDER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        totalFunded += amount;
        prana.safeTransferFrom(msg.sender, address(this), amount);
        emit EpochFunded(msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    //                          governed setters                             //
    // --------------------------------------------------------------------- //

    function setEpochIssuance(uint256 epochIssuance_) external onlyRole(ISSUANCE_ADMIN_ROLE) {
        epochIssuance = epochIssuance_;
        emit EpochIssuanceSet(epochIssuance_);
    }

    function setWindowEpochs(uint256 windowEpochs_) external onlyRole(ISSUANCE_ADMIN_ROLE) {
        if (windowEpochs_ == 0) revert ZeroWindow();
        windowEpochs = windowEpochs_;
        emit WindowEpochsSet(windowEpochs_);
    }

    // --------------------------------------------------------------------- //
    //                                views                                  //
    // --------------------------------------------------------------------- //

    /// @inheritdoc IUnifiedSharesLedger
    function claimable(address account, uint256 epoch) external view returns (uint256) {
        if (!EpochManager.isEpochClosed(epoch, epochLength)) return 0;
        if (claimed[epoch][account]) return 0;
        return _payout(account, epoch);
    }

    /// @inheritdoc IUnifiedSharesLedger
    /// @notice Pooled shares credited IN `epoch` (the single-epoch total, NOT the window sum).
    function totalSharesAt(uint256 epoch) external view returns (uint256) {
        return totalPoolShares[epoch];
    }

    /// @notice The trailing-window pooled-share sums for `account` and the pool, ending at `epoch`.
    /// @dev Exposed so off-chain accounting / sibling modules can read the exact PPLNS window numbers.
    function windowShares(address account, uint256 epoch)
        public
        view
        returns (uint256 accountWindow, uint256 totalWindow)
    {
        (uint256 startEpoch, uint256 endEpoch) = EpochManager.windowBounds(epoch, windowEpochs);
        for (uint256 e = startEpoch; e <= endEpoch; ) {
            accountWindow += poolShares[e][account];
            totalWindow += totalPoolShares[e];
            unchecked {
                ++e;
            }
        }
    }

    /// @dev Pro-rata payout for `account` over the PPLNS window ending at `epoch`.
    function _payout(address account, uint256 epoch) internal view returns (uint256) {
        (uint256 acctWin, uint256 totWin) = windowShares(account, epoch);
        if (totWin == 0 || acctWin == 0) return 0;
        return (epochIssuance * acctWin) / totWin;
    }
}
