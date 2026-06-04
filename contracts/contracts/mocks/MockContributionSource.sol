// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IContributionSource} from "../interfaces/IContributionSource.sol";

/// @notice Test-only contribution-source adapter. Stands in for the real read-through over
///         ComputeJobMarket / ProofOfSolarOracleMint / ContributionBountyEscrow: it decodes
///         (account, baseAmount) from the router-supplied `data`, optionally reverting to model
///         an unverified proof. The router treats it identically to a production adapter.
contract MockContributionSource is IContributionSource {
    bool public revertNext; // when true, the next verify reverts (models an unverified proof).

    error NotVerified(bytes32 proofId);

    function setRevert(bool v) external {
        revertNext = v;
    }

    /// @inheritdoc IContributionSource
    /// @dev `data` is abi.encode(address account, uint256 baseAmount). integer-literal decode lengths.
    function verifyContribution(bytes32 proofId, bytes calldata data)
        external
        view
        returns (address account, uint256 baseAmount)
    {
        if (revertNext) revert NotVerified(proofId);
        (account, baseAmount) = abi.decode(data, (address, uint256));
    }
}

/// @notice Test-only sink that records UnifiedSharesLedger.creditShares(...) calls without the
///         full compute stack. Implements only the surface the router touches.
contract MockSharesLedgerSink {
    enum Lane { HASH, TASK, BURN }

    struct Credit {
        address account;
        Lane lane;
        uint256 amount;
    }

    Credit[] public credits;

    event CreditObserved(address indexed account, Lane lane, uint256 amount);

    function creditShares(address account, Lane lane, uint256 amount) external {
        credits.push(Credit(account, lane, amount));
        emit CreditObserved(account, lane, amount);
    }

    function creditCount() external view returns (uint256) {
        return credits.length;
    }

    function lastCredit() external view returns (address account, Lane lane, uint256 amount) {
        Credit storage c = credits[credits.length - 1];
        return (c.account, c.lane, c.amount);
    }
}
