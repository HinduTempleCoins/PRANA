// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FrontEndFeeRebate — Proof-of-Burn incentive hook for marketplace front-ends.
/// @notice Routing a trade through OUR front-end (or any registered, allowlisted front-end)
///         earns a fee rebate. A front-end self-registers (claiming a payout recipient + a
///         rebate rate in bps); an admin allowlists it before any rebate accrues. When a trade
///         settles, the marketplace reports it here via a role-gated hook, naming the front-end
///         that originated it and the protocol fee that was charged; this contract credits a
///         `rebateBps` cut of that fee to the trader, which the trader later claims (pull
///         pattern). The rebate is bound to a Proof-of-Burn action: the front-end (or trader)
///         must have an outstanding burn-credit balance — recorded here by a burn-reporter —
///         large enough to cover the rebate, tying "use our front-end / burn" to a reduced fee.
/// @dev    This contract is a credit ledger + rebate vault. It holds a balance of the rebate
///         token (funded by the protocol/treasury, who should also call {fund}); reported
///         trades CREDIT trader balances against that vault and DEBIT the front-end's burn
///         credit. No rebate is ever credited beyond the vault's funded balance or beyond the
///         covering burn credit, so the ledger can never promise more than it can pay. The
///         marketplace holds `REPORTER_ROLE`; a burn registry / PoB oracle holds `BURNER_ROLE`.
contract FrontEndFeeRebate is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice May report settled trades (the marketplace / router).
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    /// @notice May credit a front-end's Proof-of-Burn allowance (a burn registry / PoB oracle).
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    uint16 public constant BPS_DENOM = 10000;

    /// @notice The rebate is always paid in this single token (set once at construction).
    IERC20 public immutable rebateToken;

    /// @notice Hard ceiling on any front-end's `rebateBps` (admin-set, ≤ BPS_DENOM).
    uint16 public maxRebateBps;

    /// @notice Registered front-end record.
    struct FrontEnd {
        bool registered;
        bool allowlisted; // admin gate; rebates only accrue when true
        uint16 rebateBps; // share of the protocol fee rebated to the trader (≤ maxRebateBps)
        address recipient; // operator payout recipient (unused by rebate flow; for ops/registry)
        uint256 burnCredit; // outstanding Proof-of-Burn allowance backing future rebates
    }

    /// @dev front-end id (an address chosen by the operator) => record.
    mapping(address => FrontEnd) private _frontEnds;
    /// @dev trader => claimable rebate balance (in `rebateToken`).
    mapping(address => uint256) public claimable;

    /// @notice Total rebate currently owed (sum of `claimable`); the vault must cover this.
    uint256 public totalOwed;

    event FrontEndRegistered(address indexed frontEnd, address indexed recipient, uint16 rebateBps);
    event FrontEndUpdated(address indexed frontEnd, address indexed recipient, uint16 rebateBps);
    event FrontEndAllowlisted(address indexed frontEnd, bool allowed);
    event BurnCredited(address indexed frontEnd, uint256 amount, uint256 newCredit);
    event RebateCredited(
        address indexed trader,
        address indexed frontEnd,
        uint256 fee,
        uint256 rebate
    );
    event RebateClaimed(address indexed trader, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event MaxRebateBpsSet(uint16 bps);

    error ZeroAddress();
    error ZeroAmount();
    error BadBps(uint16 bps);
    error NotRegistered(address frontEnd);
    error AlreadyRegistered(address frontEnd);
    error NotAllowlisted(address frontEnd);
    error NothingToClaim();
    error InsufficientVault(uint256 available, uint256 needed);

    /// @param admin Receives `DEFAULT_ADMIN_ROLE`, `REPORTER_ROLE` and `BURNER_ROLE` to bootstrap.
    /// @param _rebateToken Token all rebates are paid in.
    /// @param _maxRebateBps Initial ceiling on any front-end's rebate rate.
    constructor(address admin, IERC20 _rebateToken, uint16 _maxRebateBps) {
        if (admin == address(0)) revert ZeroAddress();
        if (address(_rebateToken) == address(0)) revert ZeroAddress();
        if (_maxRebateBps > BPS_DENOM) revert BadBps(_maxRebateBps);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REPORTER_ROLE, admin);
        _grantRole(BURNER_ROLE, admin);

        rebateToken = _rebateToken;
        maxRebateBps = _maxRebateBps;
        emit MaxRebateBpsSet(_maxRebateBps);
    }

    // --------------------------------------------------------------------- //
    // Front-end registration                                                 //
    // --------------------------------------------------------------------- //

    /// @notice Self-register a front-end (the caller is the front-end id). Not yet allowlisted —
    ///         an admin must call {setAllowlisted} before any rebate accrues.
    /// @param recipient Operator payout recipient (book-keeping; not the rebate target).
    /// @param rebateBps Requested rebate rate (capped at {maxRebateBps}).
    function registerFrontEnd(address recipient, uint16 rebateBps) external {
        if (recipient == address(0)) revert ZeroAddress();
        if (rebateBps > maxRebateBps) revert BadBps(rebateBps);

        FrontEnd storage f = _frontEnds[msg.sender];
        if (f.registered) revert AlreadyRegistered(msg.sender);

        f.registered = true;
        f.recipient = recipient;
        f.rebateBps = rebateBps;

        emit FrontEndRegistered(msg.sender, recipient, rebateBps);
    }

    /// @notice Update your own front-end's recipient / rebate rate.
    function updateFrontEnd(address recipient, uint16 rebateBps) external {
        if (recipient == address(0)) revert ZeroAddress();
        if (rebateBps > maxRebateBps) revert BadBps(rebateBps);

        FrontEnd storage f = _frontEnds[msg.sender];
        if (!f.registered) revert NotRegistered(msg.sender);

        f.recipient = recipient;
        f.rebateBps = rebateBps;

        emit FrontEndUpdated(msg.sender, recipient, rebateBps);
    }

    /// @notice Admin allowlists (or de-lists) a registered front-end.
    function setAllowlisted(address frontEnd, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        FrontEnd storage f = _frontEnds[frontEnd];
        if (!f.registered) revert NotRegistered(frontEnd);
        f.allowlisted = allowed;
        emit FrontEndAllowlisted(frontEnd, allowed);
    }

    /// @notice Admin sets the global cap on front-end rebate rates.
    function setMaxRebateBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > BPS_DENOM) revert BadBps(bps);
        maxRebateBps = bps;
        emit MaxRebateBpsSet(bps);
    }

    // --------------------------------------------------------------------- //
    // Proof-of-Burn credit (burn registry / PoB oracle → here)               //
    // --------------------------------------------------------------------- //

    /// @notice Credit a front-end's Proof-of-Burn allowance. Each unit of credit backs one unit
    ///         of future rebate; a reported trade debits this. Ties "burn" to "reduced fee".
    /// @dev BURNER_ROLE-gated — the caller is the trusted burn registry / PoB oracle that has
    ///      already verified the burn happened.
    function creditBurn(address frontEnd, uint256 amount) external onlyRole(BURNER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        FrontEnd storage f = _frontEnds[frontEnd];
        if (!f.registered) revert NotRegistered(frontEnd);

        f.burnCredit += amount;
        emit BurnCredited(frontEnd, amount, f.burnCredit);
    }

    // --------------------------------------------------------------------- //
    // Trade reporting (marketplace → here) + claim                           //
    // --------------------------------------------------------------------- //

    /// @notice Report a settled trade routed through `frontEnd`, charging `fee` of protocol fee.
    ///         Credits the trader a `rebateBps` cut of the fee, debiting the front-end's burn
    ///         credit and reserving it against the vault. Reverts if the front-end isn't
    ///         allowlisted, lacks covering burn credit, or the vault is underfunded.
    /// @dev REPORTER_ROLE-gated (the marketplace). The rebate is the minimum of the bps-derived
    ///      amount and the front-end's remaining burn credit, so an underfunded-burn front-end
    ///      simply earns a smaller (or zero) rebate rather than reverting the trade's accounting.
    /// @return rebate The amount credited to `trader`.
    function reportTrade(address frontEnd, address trader, uint256 fee)
        external
        onlyRole(REPORTER_ROLE)
        returns (uint256 rebate)
    {
        if (trader == address(0)) revert ZeroAddress();
        FrontEnd storage f = _frontEnds[frontEnd];
        if (!f.registered) revert NotRegistered(frontEnd);
        if (!f.allowlisted) revert NotAllowlisted(frontEnd);

        rebate = (fee * f.rebateBps) / BPS_DENOM;
        // Bind the rebate to Proof-of-Burn: never pay more than the covering burn credit.
        if (rebate > f.burnCredit) {
            rebate = f.burnCredit;
        }
        if (rebate == 0) {
            emit RebateCredited(trader, frontEnd, fee, 0);
            return 0;
        }

        // Reserve against the vault so we never promise more than we can pay.
        uint256 available = rebateToken.balanceOf(address(this)) - totalOwed;
        if (rebate > available) revert InsufficientVault(available, rebate);

        f.burnCredit -= rebate;
        claimable[trader] += rebate;
        totalOwed += rebate;

        emit RebateCredited(trader, frontEnd, fee, rebate);
    }

    /// @notice Claim your accrued rebate (pull pattern). Transfers `rebateToken` to the caller.
    function claim() external returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        claimable[msg.sender] = 0;
        totalOwed -= amount;
        rebateToken.safeTransfer(msg.sender, amount);

        emit RebateClaimed(msg.sender, amount);
    }

    /// @notice Fund the rebate vault. Anyone (treasury/protocol) may top it up.
    /// @dev Pulls `amount` of `rebateToken` from the caller (who must have approved this contract).
    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        rebateToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Admin withdraws UNRESERVED vault funds (never touches owed-but-unclaimed rebates).
    function sweep(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = rebateToken.balanceOf(address(this)) - totalOwed;
        if (amount > available) revert InsufficientVault(available, amount);
        rebateToken.safeTransfer(to, amount);
    }

    // --------------------------------------------------------------------- //
    // Views                                                                  //
    // --------------------------------------------------------------------- //

    /// @notice Read a front-end's record.
    function frontEndInfo(address frontEnd)
        external
        view
        returns (
            bool registered,
            bool allowlisted,
            uint16 rebateBps,
            address recipient,
            uint256 burnCredit
        )
    {
        FrontEnd storage f = _frontEnds[frontEnd];
        return (f.registered, f.allowlisted, f.rebateBps, f.recipient, f.burnCredit);
    }

    /// @notice Unreserved vault balance available to back new rebates.
    function availableVault() external view returns (uint256) {
        return rebateToken.balanceOf(address(this)) - totalOwed;
    }
}
