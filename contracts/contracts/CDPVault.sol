// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IMintable} from "./BurnMine.sol";
import {SimplePriceOracle} from "./SimplePriceOracle.sol";

/// @title CDPVault — minimal overcollateralized lending (Maker/Aave model)
/// @notice Deposit collateral, borrow a mintable debt token up to `maxLTV` of collateral value
///         (priced by the oracle), repay to burn debt, withdraw freed collateral. If a position's
///         health factor drops below 1 (price fell), anyone can liquidate: repay the debt, seize the
///         collateral. OVERCOLLATERALIZED ONLY — the safety is the collateral cushion (never a thin
///         token backing loans → the Terra/Luna death spiral). The vault holds minter rights on the debt token.
contract CDPVault {
    using SafeERC20 for IERC20;
    uint256 private constant WAD = 1e18;

    IERC20 public immutable collateral;
    IMintable public immutable debtToken;
    SimplePriceOracle public immutable oracle;
    uint256 public immutable maxLTV; // scaled 1e18 (e.g. 0.66e18)

    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtOf;

    event Deposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);

    constructor(IERC20 collateral_, IMintable debtToken_, SimplePriceOracle oracle_, uint256 maxLTV_) {
        require(address(collateral_) != address(0) && address(debtToken_) != address(0) && address(oracle_) != address(0), "zero");
        require(maxLTV_ > 0 && maxLTV_ <= WAD, "ltv");
        collateral = collateral_;
        debtToken = debtToken_;
        oracle = oracle_;
        maxLTV = maxLTV_;
    }

    function collateralValue(address user) public view returns (uint256) {
        return (collateralOf[user] * oracle.price(address(collateral))) / WAD;
    }

    function maxBorrow(address user) public view returns (uint256) {
        return (collateralValue(user) * maxLTV) / WAD;
    }

    /// @notice Health factor scaled 1e18; < 1e18 means liquidatable.
    function healthFactor(address user) public view returns (uint256) {
        if (debtOf[user] == 0) return type(uint256).max;
        return (maxBorrow(user) * WAD) / debtOf[user];
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(debtOf[msg.sender] + amount <= maxBorrow(msg.sender), "undercollateralized");
        debtOf[msg.sender] += amount;
        debtToken.mint(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        require(amount > 0 && amount <= debtOf[msg.sender], "bad amount");
        IERC20(address(debtToken)).safeTransferFrom(msg.sender, address(this), amount);
        ERC20Burnable(address(debtToken)).burn(amount);
        debtOf[msg.sender] -= amount;
        emit Repaid(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        require(amount > 0 && amount <= collateralOf[msg.sender], "bad amount");
        uint256 newCollateral = collateralOf[msg.sender] - amount;
        uint256 newMax = (((newCollateral * oracle.price(address(collateral))) / WAD) * maxLTV) / WAD;
        require(debtOf[msg.sender] <= newMax, "would undercollateralize");
        collateralOf[msg.sender] -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Liquidate an unhealthy position: repay its full debt, seize all its collateral.
    function liquidate(address user) external {
        require(healthFactor(user) < WAD, "healthy");
        uint256 debt = debtOf[user];
        uint256 col = collateralOf[user];
        require(debt > 0, "no debt");
        IERC20(address(debtToken)).safeTransferFrom(msg.sender, address(this), debt);
        ERC20Burnable(address(debtToken)).burn(debt);
        debtOf[user] = 0;
        collateralOf[user] = 0;
        collateral.safeTransfer(msg.sender, col);
        emit Liquidated(user, msg.sender, debt, col);
    }
}
