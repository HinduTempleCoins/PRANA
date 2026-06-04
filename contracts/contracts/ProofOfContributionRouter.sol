// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IContributionSource} from "./interfaces/IContributionSource.sol";
import {IUnifiedSharesLedger} from "./interfaces/IUnifiedSharesLedger.sol";

/// @title ProofOfContributionRouter (BI10) — the SURYA contribution glue.
/// @notice §6 "compute + solar + code collapse into ONE contribution router." A single entrypoint
///         accepts a verified contribution of a TYPED kind (COMPUTE | SOLAR | CODE), has the
///         registered source ADAPTER for that kind confirm it against its underlying module
///         (ComputeJobMarket / ProofOfSolarOracleMint / ContributionBountyEscrow), normalizes the
///         result, and routes ONE "contribution credit" into the single canonical sink: the
///         UnifiedSharesLedger (NN1). The contribution is credited to the TASK lane — the useful-work
///         lane of the chain-as-pool — pro-rata with every other contributor, so a verified compute
///         job, a verified kWh of solar, and a verified code bounty all earn from the same PPLNS pool.
///
/// @dev SINK CHOICE — UnifiedSharesLedger.creditShares(account, Lane.TASK, amount), and WHY:
///        The ledger is purpose-built to fold heterogeneous useful-work into ONE pro-rata pool with
///        per-lane creditor gating. Crediting it (vs. minting a bespoke reward token, or escrowing)
///        is the cleanest "collapse into one" because: (1) no new token / minter authority is needed
///        — the router only needs the ledger's TASK_CREDITOR role; (2) payout, funding, fee-hook and
///        epoch/PPLNS accounting already exist and are shared with the hash/burn lanes; (3) it is the
///        literal "one contribution router → one pool" the §6 brief asks for. The router therefore
///        holds the ledger's TASK_CREDITOR role and is the on-chain module that lane already expects.
///
/// @dev ADAPTER/ROUTER discipline: this contract NEVER re-implements verification. For each kind it
///      calls the registered IContributionSource adapter, which reads the real source module and
///      reverts unless the proof is genuinely verified/settled there. The router only adds: a typed
///      adapter registry (DAO/admin-managed), a per-source weight, per-contribution dedup, and the
///      single credit into the sink. All of that is router-local; none of it duplicates a module.
contract ProofOfContributionRouter is AccessControl, ReentrancyGuard {
    /// @notice The three contribution kinds the §6 router unifies.
    enum Kind {
        COMPUTE, // ComputeJobMarket — off-chain compute settled by a verifier.
        SOLAR, //   ProofOfSolarOracleMint — attested verified kWh.
        CODE //     ContributionBountyEscrow — attested code/dev bounty.
    }

    /// @notice May register/update/remove contribution-source adapters (the DAO timelock in prod).
    bytes32 public constant SOURCE_ADMIN_ROLE = keccak256("SOURCE_ADMIN_ROLE");
    /// @notice May call route() — the off-chain relayer / keeper that pushes verified proofs through.
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");

    /// @dev Weight fixed-point one (1e18 = 1x); per-source weight scales the normalized credit.
    uint256 internal constant WAD = 1e18;

    /// @notice A registered contribution-source adapter for one kind.
    struct Source {
        IContributionSource adapter; // the read-through adapter over the real source module.
        uint256 weight; // per-source pooling multiplier (1e18 = 1x), applied to the base amount.
        bool registered; // explicit presence flag (weight may legitimately differ; never relied on alone).
    }

    /// @notice kind => registered source adapter + weight.
    mapping(Kind => Source) public sources;

    /// @notice Per-contribution dedup: keccak(kind, adapter, proofId) => already routed.
    ///         Keyed on the adapter too, so re-registering a new adapter does not silently unlock
    ///         replays against a different module, and the same proofId under two kinds is distinct.
    mapping(bytes32 => bool) public routed;

    /// @notice The single canonical sink — the chain-as-pool PPLNS ledger (NN1).
    IUnifiedSharesLedger public immutable ledger;

    event SourceRegistered(Kind indexed kind, address indexed adapter, uint256 weight);
    event SourceRemoved(Kind indexed kind, address indexed adapter);
    event ContributionRouted(
        Kind indexed kind,
        bytes32 indexed proofId,
        address indexed account,
        uint256 baseAmount,
        uint256 weight,
        uint256 creditedShares
    );

    error ZeroAddress();
    error ZeroWeight();
    error KindNotRegistered(Kind kind);
    error AlreadyRouted(bytes32 dedupKey);
    error ZeroAccount();
    error ZeroBaseAmount();
    error ZeroCredit();

    /// @param ledger_ The UnifiedSharesLedger sink. This router must hold its TASK_CREDITOR role
    ///        (granted on the ledger after deploy) for route() to succeed.
    /// @param admin   DEFAULT_ADMIN_ROLE + SOURCE_ADMIN_ROLE + ROUTER_ROLE holder (DAO timelock in prod).
    constructor(IUnifiedSharesLedger ledger_, address admin) {
        if (address(ledger_) == address(0) || admin == address(0)) revert ZeroAddress();
        ledger = ledger_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOURCE_ADMIN_ROLE, admin);
        _grantRole(ROUTER_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                          source registry                              //
    // --------------------------------------------------------------------- //

    /// @notice Register or update the source adapter + weight for `kind`. DAO/admin only.
    /// @param kind    The contribution kind this adapter verifies.
    /// @param adapter The IContributionSource read-through over the real module.
    /// @param weight  Pooling multiplier (1e18 = 1x); must be > 0.
    function registerSource(Kind kind, IContributionSource adapter, uint256 weight)
        external
        onlyRole(SOURCE_ADMIN_ROLE)
    {
        if (address(adapter) == address(0)) revert ZeroAddress();
        if (weight == 0) revert ZeroWeight();
        sources[kind] = Source({adapter: adapter, weight: weight, registered: true});
        emit SourceRegistered(kind, address(adapter), weight);
    }

    /// @notice Remove the adapter for `kind`, disabling routing for it. DAO/admin only.
    function removeSource(Kind kind) external onlyRole(SOURCE_ADMIN_ROLE) {
        Source storage s = sources[kind];
        if (!s.registered) revert KindNotRegistered(kind);
        address adapter = address(s.adapter);
        delete sources[kind];
        emit SourceRemoved(kind, adapter);
    }

    // --------------------------------------------------------------------- //
    //                               routing                                 //
    // --------------------------------------------------------------------- //

    /// @notice Route ONE verified contribution into the single sink.
    /// @dev Flow: (1) load the registered adapter for `kind` (reverts if none); (2) compute the dedup
    ///      key and reject a replay; (3) MARK routed BEFORE the external verify call (checks-effects-
    ///      interactions; nonReentrant double-guards); (4) ask the adapter to confirm the proof —
    ///      it reverts unless genuinely verified in the underlying module and returns the source-bound
    ///      beneficiary + base amount (caller cannot redirect the credit); (5) apply the per-source
    ///      weight; (6) credit the TASK lane of the ledger. The router adds no verification of its own.
    /// @param kind    The contribution kind (selects the adapter).
    /// @param proofId The source-native proof id (dedup key component; passed to the adapter).
    /// @param data    Opaque adapter payload (forwarded to the adapter's read-through).
    /// @return creditedShares The weight-applied shares credited into the pool.
    function route(Kind kind, bytes32 proofId, bytes calldata data)
        external
        onlyRole(ROUTER_ROLE)
        nonReentrant
        returns (uint256 creditedShares)
    {
        Source memory s = sources[kind];
        if (!s.registered) revert KindNotRegistered(kind);

        bytes32 dedupKey = keccak256(abi.encode(kind, address(s.adapter), proofId));
        if (routed[dedupKey]) revert AlreadyRouted(dedupKey);
        // Effect before interaction: a proof can be routed at most once even if the adapter is
        // adversarial / re-enters (also guarded by nonReentrant).
        routed[dedupKey] = true;

        // Delegate verification to the adapter (read-through over the real source module).
        (address account, uint256 baseAmount) = s.adapter.verifyContribution(proofId, data);
        if (account == address(0)) revert ZeroAccount();
        if (baseAmount == 0) revert ZeroBaseAmount();

        creditedShares = (baseAmount * s.weight) / WAD;
        if (creditedShares == 0) revert ZeroCredit(); // weight rounded the credit to nothing.

        // Single canonical sink: credit the useful-work (TASK) lane of the chain-as-pool ledger.
        ledger.creditShares(account, IUnifiedSharesLedger.Lane.TASK, creditedShares);

        emit ContributionRouted(kind, proofId, account, baseAmount, s.weight, creditedShares);
    }

    // --------------------------------------------------------------------- //
    //                                views                                  //
    // --------------------------------------------------------------------- //

    /// @notice The dedup key for a (kind, proofId) against the currently-registered adapter.
    /// @dev View helper so off-chain relayers can pre-check `routed[...]` before sending.
    function dedupKey(Kind kind, bytes32 proofId) external view returns (bytes32) {
        return keccak256(abi.encode(kind, address(sources[kind].adapter), proofId));
    }

    /// @notice Whether a (kind, proofId) has already been routed against the current adapter.
    function isRouted(Kind kind, bytes32 proofId) external view returns (bool) {
        return routed[keccak256(abi.encode(kind, address(sources[kind].adapter), proofId))];
    }
}
