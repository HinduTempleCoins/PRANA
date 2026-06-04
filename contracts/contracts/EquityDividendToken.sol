// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EquityDividendToken
/// @notice An ERC-20 "share" token (the "A" token) whose holders earn dividends
///         paid out in a separate ERC-20 currency. Uses the classic
///         magnified-dividend-per-share accumulator with per-account correction
///         applied on every mint/burn/transfer so that share movements never
///         distort already-accrued or future dividend accounting.
contract EquityDividendToken is ERC20, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev 2**128. Scales per-share figures up so integer division keeps precision.
    uint256 internal constant MAGNITUDE = 2 ** 128;

    /// @notice The ERC-20 in which dividends are denominated and paid.
    IERC20 public immutable dividendToken;

    /// @dev Accumulated dividends per share, scaled by MAGNITUDE.
    uint256 public magnifiedDividendPerShare;

    /// @dev Per-account correction term keeping each holder's accumulated
    ///      dividend accurate across share transfers/mints/burns. Signed because
    ///      buying shares lowers, and selling raises, the correction.
    mapping(address => int256) internal magnifiedDividendCorrections;

    /// @dev Dividends already paid out to each account.
    mapping(address => uint256) internal withdrawnDividends;

    event DividendsDistributed(address indexed from, uint256 amount);
    event DividendWithdrawn(address indexed to, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 dividendToken_,
        address admin
    ) ERC20(name_, symbol_) {
        require(address(dividendToken_) != address(0), "EDT: zero dividend token");
        require(admin != address(0), "EDT: zero admin");
        dividendToken = dividendToken_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint new shares. Restricted to MINTER_ROLE.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Pull `amount` of the dividend currency from the caller and
    ///         distribute it across all current shareholders pro-rata.
    function distributeDividends(uint256 amount) external {
        require(totalSupply() > 0, "EDT: no shares");
        require(amount > 0, "EDT: zero amount");

        dividendToken.safeTransferFrom(msg.sender, address(this), amount);

        magnifiedDividendPerShare += (amount * MAGNITUDE) / totalSupply();
        emit DividendsDistributed(msg.sender, amount);
    }

    /// @notice Dividends `account` has earned in total over its holding history.
    function accumulativeDividendOf(address account) public view returns (uint256) {
        int256 raw = int256(magnifiedDividendPerShare * balanceOf(account)) +
            magnifiedDividendCorrections[account];
        return uint256(raw) / MAGNITUDE;
    }

    /// @notice Dividends `account` can withdraw right now.
    function withdrawableDividendOf(address account) public view returns (uint256) {
        return accumulativeDividendOf(account) - withdrawnDividends[account];
    }

    /// @notice Total dividends already withdrawn by `account`.
    function withdrawnDividendOf(address account) external view returns (uint256) {
        return withdrawnDividends[account];
    }

    /// @notice Withdraw all of the caller's outstanding dividends.
    function withdrawDividend() external {
        uint256 withdrawable = withdrawableDividendOf(msg.sender);
        require(withdrawable > 0, "EDT: nothing to withdraw");

        withdrawnDividends[msg.sender] += withdrawable;
        dividendToken.safeTransfer(msg.sender, withdrawable);
        emit DividendWithdrawn(msg.sender, withdrawable);
    }

    /// @dev OZ 5.0.2 hook covering mint (from==0), burn (to==0) and transfer.
    ///      Adjust corrections so accumulativeDividendOf stays invariant under
    ///      share movement: when shares leave `from`, its correction rises by
    ///      the value those shares would otherwise add; the mirror applies to `to`.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        int256 magnifiedCorrection = int256(magnifiedDividendPerShare * value);
        if (from != address(0)) {
            magnifiedDividendCorrections[from] += magnifiedCorrection;
        }
        if (to != address(0)) {
            magnifiedDividendCorrections[to] -= magnifiedCorrection;
        }
    }
}
