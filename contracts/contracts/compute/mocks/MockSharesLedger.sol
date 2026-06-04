// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUnifiedSharesLedger} from "../../interfaces/IUnifiedSharesLedger.sol";

/// @notice Test-only IUnifiedSharesLedger: records every creditShares() call so tests can assert
///         the creditors call into the canonical pool with the right (worker, lane, amount).
contract MockSharesLedger is IUnifiedSharesLedger {
    struct Credit {
        address account;
        Lane lane;
        uint256 amount;
    }

    Credit[] public credits;
    // account => lane => running total
    mapping(address => mapping(uint8 => uint256)) public creditedTo;

    uint256 private _epochLength = 3600;
    uint256 private _windowEpochs = 24;
    uint256 private _epochIssuance = 1e18;

    function creditShares(address account, Lane lane, uint256 amount) external override {
        credits.push(Credit({account: account, lane: lane, amount: amount}));
        creditedTo[account][uint8(lane)] += amount;
        emit SharesCredited(0, lane, account, amount);
    }

    function creditsLength() external view returns (uint256) {
        return credits.length;
    }

    function lastCredit() external view returns (address account, Lane lane, uint256 amount) {
        Credit storage c = credits[credits.length - 1];
        return (c.account, c.lane, c.amount);
    }

    // --- unused view surface (satisfy the interface) ---
    function claim(uint256) external pure override returns (uint256) {
        return 0;
    }

    function claimable(address, uint256) external pure override returns (uint256) {
        return 0;
    }

    function epochLength() external view override returns (uint256) {
        return _epochLength;
    }

    function windowEpochs() external view override returns (uint256) {
        return _windowEpochs;
    }

    function epochIssuance() external view override returns (uint256) {
        return _epochIssuance;
    }

    function totalSharesAt(uint256) external pure override returns (uint256) {
        return 0;
    }
}
