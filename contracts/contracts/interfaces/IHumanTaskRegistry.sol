// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IHumanTaskRegistry — DAO-governed catalog of HUMAN task-types (the human mirror of
///         {ITaskRegistry}).
/// @notice Where {ITaskRegistry} catalogs AI/scientific compute tasks, this catalogs the human
///         data-work that trains the models: preference ranking (RLHF), supervised demonstrations
///         (SFT), red-team / eval, annotation, surveys, focus groups, expert elicitation, curation.
///         Each entry carries a spec hash, a kind, the {IHumanContributionGate} that verifies it, a
///         TASK-lane share-weight, a minimum reputation tier, a two-buyer flag (the same contribution
///         can serve BOTH AI-training and market-research buyers), and an enabled flag.
interface IHumanTaskRegistry {
    /// @notice The flavor of human work — drives off-chain UX and which gold-task checks apply.
    enum Kind {
        PREFERENCE_RANK, // 0 — RLHF-style A/B preference ranking
        SFT,             // 1 — supervised fine-tuning demonstrations
        EVAL_REDTEAM,    // 2 — evaluation / adversarial red-teaming
        ANNOTATION,      // 3 — labeling / annotation
        SURVEY,          // 4 — structured survey responses
        FOCUS_GROUP,     // 5 — moderated focus-group input
        EXPERT,          // 6 — expert elicitation
        CURATION         // 7 — dataset curation / filtering
    }

    struct TaskType {
        bytes32 specHash;          // off-chain task spec
        Kind kind;                 // the flavor of human work
        address verificationGate;  // which IHumanContributionGate verifies completions
        uint256 shareWeight;       // TASK-lane weight applied when crediting (1e18 = 1x = equal-to-hash)
        uint256 minReputation;     // minimum reputation TIER required to be credited for this task
        bool twoBuyer;             // serves BOTH AI-training and market-research buyers
        bool enabled;              // currently routable / creditable
    }

    event HumanTaskTypeSet(
        bytes32 indexed taskId,
        bytes32 specHash,
        Kind kind,
        address verificationGate,
        uint256 shareWeight,
        uint256 minReputation,
        bool twoBuyer,
        bool enabled
    );

    function taskType(bytes32 taskId) external view returns (TaskType memory);
    function isEnabled(bytes32 taskId) external view returns (bool);
    function shareWeight(bytes32 taskId) external view returns (uint256);
    function minReputation(bytes32 taskId) external view returns (uint256);
}
