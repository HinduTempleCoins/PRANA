// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRateOracle} from "../interfaces/IFeeRateOracle.sol";

/// @title SettlementFeeHook (PP1) — the Hathor skim, taken inline at ledger settlement.
/// @notice This is the single chokepoint where the protocol fee is taken. The UnifiedSharesLedger
///         sets this hook's address and calls it during {claim}. Because the skim happens at
///         ON-CHAIN SETTLEMENT of the shares ledger (not at any front-end), EVERY coordinator /
///         "run-your-own-pool" pays it identically — there is no front-end to route around.
///
///         Flow per settlement (pull model — ledger holds the payout token):
///           1. Ledger computes a claimant's gross payout `amount`.
///           2. Ledger calls {settle}(token, claimant, amount) (gated to LEDGER_ROLE).
///           3. Hook reads the CURRENT rate from {IFeeRateOracle.currentRateBps} (rules-based,
///              countercyclical, bootstrap-vs-steady — see CountercyclicalFeeOracle).
///           4. Hook computes fee = amount * rate / 1e4, pulls `fee` from the ledger to the Hathor
///              treasury and `amount - fee` from the ledger to the claimant, and returns `net`.
///         The hook never custodies funds beyond the atomic pull-through, and never trades.
///
///         EMBEDDING: the ledger must (a) hold `LEDGER_ROLE` here, and (b) have approved this hook
///         to pull the payout token (or call from a context where this hook is allowed to move the
///         token). The hook moves tokens via transferFrom on the ledger, so the ledger sets an
///         allowance to this hook once. `quote(amount)` lets the ledger pre-compute net for views
///         like {claimable} without moving funds, so off-chain reads match on-chain settlement.
///
/// @dev Single-responsibility: rate is OUTSOURCED to the oracle (read-only), treasury is the sink.
///      Swapping the oracle is a governed action (RATE_ADMIN_ROLE → DAO/timelock); the treasury is
///      immutable wiring so the skim destination can never be quietly repointed.
contract SettlementFeeHook is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice Role for the shares ledger — the only caller permitted to trigger a skim.
    bytes32 public constant LEDGER_ROLE = keccak256("LEDGER_ROLE");
    /// @notice Role allowed to repoint the rate oracle (DAO/timelock). Treasury is NOT repointable.
    bytes32 public constant RATE_ADMIN_ROLE = keccak256("RATE_ADMIN_ROLE");

    uint16 public constant BPS_DENOM = 10000;

    /// @notice The Hathor fee treasury (never trades). Immutable so the skim destination is fixed.
    address public immutable treasury;
    /// @notice The read-only, rules-based rate source.
    IFeeRateOracle public rateOracle;

    event RateOracleUpdated(address indexed oracle);
    event Skimmed(
        address indexed token,
        address indexed payee,
        uint256 gross,
        uint256 fee,
        uint256 net,
        uint16 rateBps
    );

    error ZeroAddress();

    /// @param admin     DEFAULT_ADMIN_ROLE + RATE_ADMIN_ROLE (the DAO/timelock).
    /// @param ledger    Granted LEDGER_ROLE (the UnifiedSharesLedger). May be address(0) if wired later.
    /// @param treasury_ The Hathor fee treasury (skim destination). Immutable.
    /// @param oracle    The countercyclical fee-rate oracle.
    constructor(address admin, address ledger, address treasury_, IFeeRateOracle oracle) {
        if (admin == address(0) || treasury_ == address(0) || address(oracle) == address(0)) {
            revert ZeroAddress();
        }
        treasury = treasury_;
        rateOracle = oracle;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RATE_ADMIN_ROLE, admin);
        if (ledger != address(0)) _grantRole(LEDGER_ROLE, ledger);
        emit RateOracleUpdated(address(oracle));
    }

    /// @notice DAO/timelock-only: repoint the rate oracle (e.g. to a new curve implementation).
    function setRateOracle(IFeeRateOracle oracle) external onlyRole(RATE_ADMIN_ROLE) {
        if (address(oracle) == address(0)) revert ZeroAddress();
        rateOracle = oracle;
        emit RateOracleUpdated(address(oracle));
    }

    /// @notice Pure view of the skim split for a gross `amount` at the current rate. Lets the
    ///         ledger pre-compute `net` in `claimable()` so off-chain reads match settlement.
    /// @return fee  The Hathor skim. @return net The amount the claimant receives. @return rateBps The rate used.
    function quote(uint256 amount) public view returns (uint256 fee, uint256 net, uint16 rateBps) {
        rateBps = rateOracle.currentRateBps();
        fee = (amount * rateBps) / BPS_DENOM;
        net = amount - fee;
    }

    /// @notice Called inline by the ledger at payout. Pulls `fee` to the treasury and `net` to the
    ///         `payee` from the ledger's balance, returns `net`. LEDGER_ROLE only.
    /// @dev The ledger must have approved this hook to spend `token`. fee==0 (sub-threshold dust)
    ///      skips the treasury transfer. Net is always paid out (even if fee==0).
    function settle(IERC20 token, address payee, uint256 amount)
        external
        onlyRole(LEDGER_ROLE)
        returns (uint256 net)
    {
        if (payee == address(0)) revert ZeroAddress();
        uint16 rateBps;
        uint256 fee;
        (fee, net, rateBps) = quote(amount);

        if (fee > 0) {
            token.safeTransferFrom(msg.sender, treasury, fee);
        }
        if (net > 0) {
            token.safeTransferFrom(msg.sender, payee, net);
        }
        emit Skimmed(address(token), payee, amount, fee, net, rateBps);
    }
}
