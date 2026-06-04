// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title DAOFundEmissionSplit — Peanut-style auto-slice of every emission to a DAO fund
/// @notice Sits in front of a normal rewards distributor and skims a fixed, DAO-configurable
///         basis-point slice (e.g. 10% = 1000 bps) of every inflow to a DAO fund address; the
///         remainder is forwarded onward to the main distributor.
/// @dev Push-on-demand split: tokens are sent here (by an emission scheduler / fee route), then
///      anyone calls `distribute(token)` to flush. The split reads this contract's CURRENT balance
///      so it is robust to dust and to fee-on-transfer arrivals (it only ever moves what it holds).
///      The slice bps is governed by DEFAULT_ADMIN_ROLE and hard-capped at `MAX_DAO_BPS`.
contract DAOFundEmissionSplit is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice Denominator for basis-point math (100% = 10000 bps).
    uint16 public constant BPS_DENOMINATOR = 10000;

    /// @notice Hard cap on the DAO slice — governance can never route more than 20% away from
    ///         the main distributor. Protects rewards recipients from a captured admin key.
    uint16 public constant MAX_DAO_BPS = 2000;

    /// @notice Current DAO slice in basis points (of every inflow).
    uint16 public daoBps;

    /// @notice Destination for the skimmed DAO slice.
    address public daoFund;

    /// @notice Destination for the remainder (the normal rewards distributor).
    address public mainDistributor;

    error ZeroAddress();
    error BpsAboveCap(uint16 got, uint16 cap);

    /// @param token       the reward token that was split.
    /// @param total       total amount flushed this call (this contract's balance at call time).
    /// @param toDaoFund   amount routed to the DAO fund.
    /// @param toMain      amount routed onward to the main distributor.
    event Split(address indexed token, uint256 total, uint256 toDaoFund, uint256 toMain);

    /// @param daoBps          new DAO slice in bps.
    /// @param daoFund         DAO fund address.
    /// @param mainDistributor main distributor address.
    event Configured(uint16 daoBps, address daoFund, address mainDistributor);

    /// @param admin           DEFAULT_ADMIN_ROLE holder (the DAO / timelock).
    /// @param daoFund_        initial DAO fund address.
    /// @param mainDistributor_ initial main distributor address.
    /// @param daoBps_         initial DAO slice in bps (<= MAX_DAO_BPS).
    constructor(address admin, address daoFund_, address mainDistributor_, uint16 daoBps_) {
        if (admin == address(0) || daoFund_ == address(0) || mainDistributor_ == address(0)) {
            revert ZeroAddress();
        }
        if (daoBps_ > MAX_DAO_BPS) revert BpsAboveCap(daoBps_, MAX_DAO_BPS);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        daoFund = daoFund_;
        mainDistributor = mainDistributor_;
        daoBps = daoBps_;
        emit Configured(daoBps_, daoFund_, mainDistributor_);
    }

    // --------------------------------------------------------------------- //
    //                              Governance                               //
    // --------------------------------------------------------------------- //

    /// @notice Update the DAO slice. Capped at MAX_DAO_BPS.
    function setDaoBps(uint16 daoBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (daoBps_ > MAX_DAO_BPS) revert BpsAboveCap(daoBps_, MAX_DAO_BPS);
        daoBps = daoBps_;
        emit Configured(daoBps_, daoFund, mainDistributor);
    }

    /// @notice Update the DAO fund destination.
    function setDaoFund(address daoFund_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (daoFund_ == address(0)) revert ZeroAddress();
        daoFund = daoFund_;
        emit Configured(daoBps, daoFund_, mainDistributor);
    }

    /// @notice Update the main distributor destination.
    function setMainDistributor(address mainDistributor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mainDistributor_ == address(0)) revert ZeroAddress();
        mainDistributor = mainDistributor_;
        emit Configured(daoBps, daoFund, mainDistributor_);
    }

    // --------------------------------------------------------------------- //
    //                                Split                                  //
    // --------------------------------------------------------------------- //

    /// @notice Pending balance of `token` held here awaiting a split.
    function pending(IERC20 token) external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Read this contract's current `token` balance, send `daoBps` of it to the DAO fund
    ///         and the remainder to the main distributor. No-ops when the balance is zero.
    /// @dev The main distributor receives `total - toDao` so no dust is ever left behind.
    function distribute(IERC20 token) external returns (uint256 toDao, uint256 toMain) {
        uint256 total = token.balanceOf(address(this));
        if (total == 0) return (0, 0);

        toDao = (total * daoBps) / BPS_DENOMINATOR;
        toMain = total - toDao;

        if (toDao > 0) token.safeTransfer(daoFund, toDao);
        if (toMain > 0) token.safeTransfer(mainDistributor, toMain);

        emit Split(address(token), total, toDao, toMain);
    }
}
