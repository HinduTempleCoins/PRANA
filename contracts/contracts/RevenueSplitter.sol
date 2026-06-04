// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RevenueSplitter — immutable, pull-based %-split of incoming funds (0xSplits/PaymentSplitter)
/// @notice Set payees + shares once at deploy. Incoming native or ERC-20 is split by share; each
///         payee pulls their cut. Immutable (no owner, no re-config) → safe to point fee routes at.
contract RevenueSplitter {
    using SafeERC20 for IERC20;

    address[] public payees;
    mapping(address => uint256) public shareOf;
    uint256 public totalShares;

    // native accounting
    uint256 public nativeTotalReleased;
    mapping(address => uint256) public nativeReleased;
    // erc20 accounting: token => payee => released, token => total released
    mapping(address => mapping(address => uint256)) public erc20Released;
    mapping(address => uint256) public erc20TotalReleased;

    event NativeReleased(address indexed to, uint256 amount);
    event ERC20Released(address indexed token, address indexed to, uint256 amount);

    constructor(address[] memory payees_, uint256[] memory shares_) {
        require(payees_.length == shares_.length && payees_.length > 0, "bad length");
        uint256 s;
        for (uint256 i; i < payees_.length; i++) {
            address p = payees_[i];
            require(p != address(0) && shares_[i] > 0 && shareOf[p] == 0, "bad payee");
            payees.push(p);
            shareOf[p] = shares_[i];
            s += shares_[i];
        }
        totalShares = s;
    }

    receive() external payable {}

    function releasableNative(address payee) public view returns (uint256) {
        uint256 sh = shareOf[payee];
        if (sh == 0) return 0;
        uint256 totalReceived = address(this).balance + nativeTotalReleased;
        return (totalReceived * sh) / totalShares - nativeReleased[payee];
    }

    function releaseNative(address payable payee) external {
        uint256 amount = releasableNative(payee);
        require(amount > 0, "nothing");
        nativeReleased[payee] += amount;
        nativeTotalReleased += amount;
        (bool ok, ) = payee.call{value: amount}("");
        require(ok, "send failed");
        emit NativeReleased(payee, amount);
    }

    function releasableERC20(IERC20 token, address payee) public view returns (uint256) {
        uint256 sh = shareOf[payee];
        if (sh == 0) return 0;
        uint256 totalReceived = token.balanceOf(address(this)) + erc20TotalReleased[address(token)];
        return (totalReceived * sh) / totalShares - erc20Released[address(token)][payee];
    }

    function releaseERC20(IERC20 token, address payee) external {
        uint256 amount = releasableERC20(token, payee);
        require(amount > 0, "nothing");
        erc20Released[address(token)][payee] += amount;
        erc20TotalReleased[address(token)] += amount;
        token.safeTransfer(payee, amount);
        emit ERC20Released(address(token), payee, amount);
    }

    function payeeCount() external view returns (uint256) {
        return payees.length;
    }
}
