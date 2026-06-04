// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title VeGovernor — an OZ Governor whose voting weight is time-decaying vote-escrow weight.
/// @notice Identical governance machinery to a standard token-snapshot Governor (settings, simple
///         For/Against/Abstain counting, percentage quorum, timelock-gated execution) EXCEPT the
///         source of voting power: instead of an ERC20Votes token snapshot, power comes from a
///         {VeVotesAdapter} sitting in front of {VoteEscrow}. Longer/larger locks → more weight,
///         decaying to zero at unlock — so governance flows to *committed* stake, not idle balance.
///
/// @dev The adapter is passed as the `IVotes token`. It is NOT an ERC20Votes token; it is a
///      checkpoint façade over ve weight. Because the adapter has no automatic checkpointing,
///      voters MUST checkpoint their ve weight (via the adapter) before the proposal snapshot block
///      or they read as zero votes — see {VeVotesAdapter} NatSpec for the decay/staleness contract.
///      Override list mirrors GovernorDAO verbatim (the OZ 5.0.2 multiple-inheritance requirements):
///      no `propose` override, `proposalThreshold` override required, and `supportsInterface` must
///      override only {Governor} (NOT list GovernorTimelockControl).
contract VeGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    /// @param veVotes  the {VeVotesAdapter} (an {IVotes}) sourcing time-decaying ve voting power.
    /// @param timelock the TimelockController (e.g. {DAOTimelock}) that owns/executes proposals.
    constructor(IVotes veVotes, TimelockController timelock)
        Governor("VeGovernor")
        // Short windows suited to a fast dev/test chain:
        //   votingDelay  = 1 block, votingPeriod = 50 blocks, proposalThreshold = 0.
        GovernorSettings(1 /* 1 block */, 50 /* ~50 blocks */, 0)
        GovernorVotes(veVotes)
        // 4% of the checkpointed total ve weight must vote For/Abstain for quorum.
        GovernorVotesQuorumFraction(4)
        GovernorTimelockControl(timelock)
    {}

    // ---- required overrides for OZ 5.0.2 multiple inheritance (verbatim from GovernorDAO) ----

    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(Governor)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
