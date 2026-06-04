// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Minimal read interface over a human-verification / reputation module (the suite planned
///      under contracts/contracts/human/: ProofOfHumanCredential / ReputationRegistry). DataDAO
///      never re-implements verification — it asks this oracle whether a contributor is a
///      verified human at record time and stamps that flag onto the contribution's provenance.
///      NOTE (integration): no such module exists in the repo yet. DataDAO is wired to an
///      OPTIONAL `IHumanVerifier`; when the human-contribution suite ships, set it via
///      {setHumanVerifier} and the curator's claimed `verifiedHuman` flag is cross-checked
///      against it. With the verifier unset (address(0)) the contract trusts the authorized
///      CURATOR_ROLE's flag — that role is itself the HumanTaskCreditor in the intended wiring.
interface IHumanVerifier {
    /// @return True iff `account` currently holds a verified-human credential.
    function isVerifiedHuman(address account) external view returns (bool);
}

/// @title DataDAO — the verified dataset as a community-owned, licensable asset
/// @notice The AI/GridCoin compute economy (Round 9, §9) turns human-supplied, human-verified
///         contributions into training corpora. DataDAO is the on-chain *ledger of ownership*
///         over those corpora and the *settlement rail* that pays the people who built them.
///
///         Two halves:
///         1. PROVENANCE. An authorized creditor (the HumanTaskCreditor, holding CURATOR_ROLE —
///            in practice the same module that verifies a human completed a task) records each
///            accepted contribution: {contributor, datasetId, weight, verifiedHuman, timestamp}.
///            Weight accumulates per (datasetId, contributor); the dataset's `totalWeight` is the
///            sum. This is the moat: a dataset whose every contribution carries a verified-human
///            provenance stamp is a premium, defensibly-clean training set — the thing AI builders
///            cannot get from scraped or synthetic data.
///         2. LICENSING. An outside AI builder / researcher pays (native PRANA or an ERC-20) to
///            license a `datasetId`. The DAO sets the per-dataset price and a `termsHash` (the
///            off-chain license terms the payment is consideration for). The payment is escrowed
///            and split PRO-RATA to that dataset's contributors by their accumulated weight, minus
///            an optional protocol cut to the DAO treasury. Contributors PULL their share — there
///            is no loop over contributors at license time, so a 10k-contributor corpus licenses
///            in O(1) gas and no single griefing payee can block the split.
///
/// @dev Money paths are ReentrancyGuard-protected and use SafeERC20. The split is pull-payment:
///      each license deposits into per-(token,datasetId) accumulators and contributors claim
///      against a snapshot of their weight share. A dataset may be licensed many times and in
///      multiple pay tokens; each contributor's claimable is tracked per pay token.
contract DataDAO is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice Records contributions (the HumanTaskCreditor / a human curator).
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");
    /// @notice Governs the registry: opens datasets, sets price/terms, sets protocol cut.
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    /// @notice Bps denominator (10000 = 100%).
    uint256 public constant BPS = 10_000;
    /// @notice Sentinel pay-token address representing native PRANA in the accounting maps.
    address public constant NATIVE = address(0);

    // ---------------------------------------------------------------------
    // Provenance
    // ---------------------------------------------------------------------

    /// @notice One recorded, accepted contribution to a dataset.
    struct Contribution {
        address contributor;
        uint256 datasetId;
        uint256 weight;
        bool verifiedHuman;
        uint64 timestamp;
    }

    /// @notice A licensable dataset.
    struct Dataset {
        bool exists;
        bool open; // accepting new contributions
        uint256 totalWeight; // sum of all contributors' accumulated weight
        IERC20 payToken; // address(0) => native PRANA
        uint256 price; // price for ONE license, in payToken's smallest unit
        bytes32 termsHash; // hash of the off-chain license terms
    }

    /// @notice Flattened read view for licenseInfo() — returned as a single memory struct so the
    ///         getter is one stack slot (a 7-value flat tuple overflowed the stack without via-ir).
    struct LicenseView {
        bool exists;
        bool open;
        address payToken;
        uint256 price;
        bytes32 termsHash;
        uint256 totalWeight;
        uint256 licensesSold;
    }

    /// @notice datasetId => dataset record.
    mapping(uint256 => Dataset) public datasets;
    /// @notice datasetId => contributor => accumulated weight.
    mapping(uint256 => mapping(address => uint256)) public contributionWeightOf;
    /// @notice Append-only provenance log (every recorded contribution).
    Contribution[] public contributions;

    /// @notice Total number of licenses ever sold per dataset (informational).
    mapping(uint256 => uint256) public licenseCount;

    // ---------------------------------------------------------------------
    // Pull-payment split accounting
    // ---------------------------------------------------------------------
    // For each (datasetId, payToken) we accumulate a "reward per weight" index scaled by ACC.
    // A contributor's owed = weight * (accRewardPerWeight - userDebt) / ACC. On claim we settle
    // and bump their debt to the current index. This is the MasterChef pull-split: O(1) deposit
    // (one license payment touches only the index, not N contributors) and O(1) claim, with no
    // unbounded loop anywhere. Late-recorded contributors only share in licenses sold AFTER they
    // were credited (their debt starts at the index value when first credited for that token).

    uint256 private constant ACC = 1e18;

    /// @notice datasetId => payToken => cumulative reward-per-weight index (scaled by ACC).
    mapping(uint256 => mapping(address => uint256)) public accRewardPerWeight;
    /// @notice datasetId => payToken => contributor => settled debt against the index.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public rewardDebt;
    /// @notice datasetId => payToken => contributor => already-credited-but-unclaimed amount.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public pendingOf;

    /// @notice payToken => total protocol cut accrued to the treasury (pull by DAO).
    mapping(address => uint256) public protocolFees;
    /// @notice Protocol cut taken from each license payment, in bps.
    uint256 public protocolFeeBps;
    /// @notice Treasury that pulls the protocol fees.
    address public treasury;

    /// @notice Optional human-verification oracle (see IHumanVerifier). Unset => trust curator.
    IHumanVerifier public humanVerifier;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event DatasetCreated(uint256 indexed datasetId, address indexed payToken, uint256 price, bytes32 termsHash);
    event DatasetTermsUpdated(uint256 indexed datasetId, address indexed payToken, uint256 price, bytes32 termsHash);
    event DatasetOpenSet(uint256 indexed datasetId, bool open);
    event ContributionRecorded(
        uint256 indexed datasetId,
        address indexed contributor,
        uint256 weight,
        bool verifiedHuman,
        uint256 newTotalWeight,
        uint256 contributionIndex
    );
    event DatasetLicensed(
        uint256 indexed datasetId,
        address indexed licensee,
        address indexed payToken,
        uint256 amount,
        uint256 protocolCut,
        bytes32 termsHash
    );
    event ProceedsClaimed(uint256 indexed datasetId, address indexed payToken, address indexed contributor, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed payToken, address indexed to, uint256 amount);
    event ProtocolFeeBpsSet(uint256 bps);
    event TreasurySet(address indexed treasury);
    event HumanVerifierSet(address indexed verifier);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error UnknownDataset();
    error DatasetExists();
    error DatasetClosed();
    error ZeroAddress();
    error ZeroWeight();
    error ZeroPrice();
    error NotVerifiedHuman();
    error WrongPayment();
    error NativeNotAccepted();
    error NothingToClaim();
    error FeeTooHigh();
    error NativeSendFailed();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param admin    Gets DEFAULT_ADMIN_ROLE + DAO_ROLE (the governance multisig/timelock).
    /// @param curator  Gets CURATOR_ROLE (the HumanTaskCreditor).
    /// @param treasury_ Receives the protocol cut.
    /// @param protocolFeeBps_ Initial protocol cut in bps (<= BPS).
    constructor(address admin, address curator, address treasury_, uint256 protocolFeeBps_) {
        if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > BPS) revert FeeTooHigh();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DAO_ROLE, admin);
        if (curator != address(0)) _grantRole(CURATOR_ROLE, curator);
        treasury = treasury_;
        protocolFeeBps = protocolFeeBps_;
        emit TreasurySet(treasury_);
        emit ProtocolFeeBpsSet(protocolFeeBps_);
    }

    // ---------------------------------------------------------------------
    // DAO: registry + terms
    // ---------------------------------------------------------------------

    /// @notice Open a new dataset for contributions and set its license terms.
    /// @param datasetId Caller-chosen id (e.g. keccak of the dataset name); must be unused.
    /// @param payToken  ERC-20 license is paid in, or address(0) for native PRANA.
    /// @param price     Price of one license (smallest unit); may be 0 to set later.
    /// @param termsHash Hash of the off-chain license agreement.
    function createDataset(uint256 datasetId, address payToken, uint256 price, bytes32 termsHash)
        external
        onlyRole(DAO_ROLE)
    {
        Dataset storage d = datasets[datasetId];
        if (d.exists) revert DatasetExists();
        d.exists = true;
        d.open = true;
        d.payToken = IERC20(payToken);
        d.price = price;
        d.termsHash = termsHash;
        emit DatasetCreated(datasetId, payToken, price, termsHash);
    }

    /// @notice Update a dataset's pay token / price / terms hash.
    function setDatasetTerms(uint256 datasetId, address payToken, uint256 price, bytes32 termsHash)
        external
        onlyRole(DAO_ROLE)
    {
        Dataset storage d = datasets[datasetId];
        if (!d.exists) revert UnknownDataset();
        d.payToken = IERC20(payToken);
        d.price = price;
        d.termsHash = termsHash;
        emit DatasetTermsUpdated(datasetId, payToken, price, termsHash);
    }

    /// @notice Open or close a dataset to new contributions (licensing stays available).
    function setDatasetOpen(uint256 datasetId, bool open_) external onlyRole(DAO_ROLE) {
        Dataset storage d = datasets[datasetId];
        if (!d.exists) revert UnknownDataset();
        d.open = open_;
        emit DatasetOpenSet(datasetId, open_);
    }

    /// @notice Set the protocol cut (bps) skimmed from each license payment.
    function setProtocolFeeBps(uint256 bps) external onlyRole(DAO_ROLE) {
        if (bps > BPS) revert FeeTooHigh();
        protocolFeeBps = bps;
        emit ProtocolFeeBpsSet(bps);
    }

    /// @notice Set the treasury that receives protocol fees.
    function setTreasury(address treasury_) external onlyRole(DAO_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Set (or clear) the human-verification oracle.
    function setHumanVerifier(address verifier) external onlyRole(DAO_ROLE) {
        humanVerifier = IHumanVerifier(verifier);
        emit HumanVerifierSet(verifier);
    }

    // ---------------------------------------------------------------------
    // Provenance: record contributions
    // ---------------------------------------------------------------------

    /// @notice Record an accepted contribution, accumulating `contributor`'s weight in `datasetId`.
    /// @dev    CURATOR_ROLE only (the HumanTaskCreditor). If a human verifier is configured, the
    ///         claimed `verifiedHuman` flag is cross-checked against it for truthiness. The new
    ///         weight is added at the CURRENT reward index so the contributor only shares in
    ///         licenses sold after this point (no retroactive dilution of prior licensees' splits,
    ///         and no theft of already-deposited proceeds by a late joiner).
    /// @return contributionIndex Index of the appended provenance record.
    function recordContribution(uint256 datasetId, address contributor, uint256 weight, bool verifiedHuman)
        external
        onlyRole(CURATOR_ROLE)
        returns (uint256 contributionIndex)
    {
        Dataset storage d = datasets[datasetId];
        if (!d.exists) revert UnknownDataset();
        if (!d.open) revert DatasetClosed();
        if (contributor == address(0)) revert ZeroAddress();
        if (weight == 0) revert ZeroWeight();
        if (verifiedHuman && address(humanVerifier) != address(0)) {
            if (!humanVerifier.isVerifiedHuman(contributor)) revert NotVerifiedHuman();
        }

        // Settle the contributor's pending proceeds for the dataset's CURRENT pay token before
        // changing their weight, so the index math stays exact across a weight bump.
        address tok = address(d.payToken);
        _accrue(datasetId, tok, contributor);

        contributionWeightOf[datasetId][contributor] += weight;
        d.totalWeight += weight;

        // Re-base the contributor's debt to the new weight at the current index.
        rewardDebt[datasetId][tok][contributor] =
            (contributionWeightOf[datasetId][contributor] * accRewardPerWeight[datasetId][tok]) / ACC;

        contributionIndex = contributions.length;
        contributions.push(
            Contribution({
                contributor: contributor,
                datasetId: datasetId,
                weight: weight,
                verifiedHuman: verifiedHuman,
                timestamp: uint64(block.timestamp)
            })
        );

        emit ContributionRecorded(datasetId, contributor, weight, verifiedHuman, d.totalWeight, contributionIndex);
    }

    // ---------------------------------------------------------------------
    // Licensing
    // ---------------------------------------------------------------------

    /// @notice License `datasetId`. Pays `price` in the dataset's pay token; the payment (minus
    ///         the protocol cut) is escrowed and distributed pro-rata to contributors by weight.
    /// @dev    Native datasets require `msg.value == price`; ERC-20 datasets pull `price` via
    ///         transferFrom and reject any accidental native value. O(1): only the dataset's
    ///         reward index moves — contributors pull their share later.
    function license(uint256 datasetId) external payable nonReentrant {
        Dataset storage d = datasets[datasetId];
        if (!d.exists) revert UnknownDataset();
        if (d.price == 0) revert ZeroPrice();
        if (d.totalWeight == 0) revert ZeroWeight();

        address tok = address(d.payToken);
        uint256 amount = d.price;

        if (tok == NATIVE) {
            if (msg.value != amount) revert WrongPayment();
        } else {
            if (msg.value != 0) revert NativeNotAccepted();
            // Pull exactly `amount`. (FoT pay tokens are out of scope; the DAO chooses pay tokens.)
            IERC20(tok).safeTransferFrom(msg.sender, address(this), amount);
        }

        uint256 cut = (amount * protocolFeeBps) / BPS;
        uint256 toSplit = amount - cut;
        if (cut > 0) protocolFees[tok] += cut;

        // Distribute `toSplit` across the dataset's weight by bumping the reward index.
        accRewardPerWeight[datasetId][tok] += (toSplit * ACC) / d.totalWeight;

        unchecked {
            licenseCount[datasetId] += 1;
        }

        emit DatasetLicensed(datasetId, msg.sender, tok, amount, cut, d.termsHash);
    }

    // ---------------------------------------------------------------------
    // Claims (pull-payment split)
    // ---------------------------------------------------------------------

    /// @notice Amount of `payToken` currently claimable by `contributor` from `datasetId`.
    function claimable(uint256 datasetId, address payToken, address contributor) public view returns (uint256) {
        uint256 w = contributionWeightOf[datasetId][contributor];
        uint256 accrued = (w * accRewardPerWeight[datasetId][payToken]) / ACC;
        uint256 debt = rewardDebt[datasetId][payToken][contributor];
        uint256 owed = accrued > debt ? accrued - debt : 0;
        return pendingOf[datasetId][payToken][contributor] + owed;
    }

    /// @notice Claim `contributor`'s share of `datasetId` proceeds in `payToken`. Anyone may
    ///         trigger; funds only ever go to `contributor` (pull pattern, gas-bomb-proof split).
    function claim(uint256 datasetId, address payToken, address contributor) external nonReentrant {
        if (!datasets[datasetId].exists) revert UnknownDataset();
        _accrue(datasetId, payToken, contributor);

        uint256 amount = pendingOf[datasetId][payToken][contributor];
        if (amount == 0) revert NothingToClaim();
        pendingOf[datasetId][payToken][contributor] = 0; // effects before interaction

        if (payToken == NATIVE) {
            (bool ok, ) = payable(contributor).call{value: amount}("");
            if (!ok) revert NativeSendFailed();
        } else {
            IERC20(payToken).safeTransfer(contributor, amount);
        }

        emit ProceedsClaimed(datasetId, payToken, contributor, amount);
    }

    /// @notice DAO withdraws accrued protocol fees in `payToken` to the treasury.
    function withdrawProtocolFees(address payToken) external nonReentrant {
        uint256 amount = protocolFees[payToken];
        if (amount == 0) revert NothingToClaim();
        protocolFees[payToken] = 0;
        address to = treasury;
        if (payToken == NATIVE) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert NativeSendFailed();
        } else {
            IERC20(payToken).safeTransfer(to, amount);
        }
        emit ProtocolFeesWithdrawn(payToken, to, amount);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Move a contributor's accrued (index-based) proceeds into their pending balance and
    ///      re-base their debt to the current index. Idempotent; safe to call before any weight
    ///      change or claim.
    function _accrue(uint256 datasetId, address payToken, address contributor) internal {
        uint256 w = contributionWeightOf[datasetId][contributor];
        uint256 acc = accRewardPerWeight[datasetId][payToken];
        uint256 accrued = (w * acc) / ACC;
        uint256 debt = rewardDebt[datasetId][payToken][contributor];
        if (accrued > debt) {
            pendingOf[datasetId][payToken][contributor] += (accrued - debt);
        }
        rewardDebt[datasetId][payToken][contributor] = accrued;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Total accumulated weight across all contributors of `datasetId`.
    function totalWeight(uint256 datasetId) external view returns (uint256) {
        return datasets[datasetId].totalWeight;
    }

    /// @notice License terms for `datasetId`, as a single memory struct (stack-safe).
    function licenseInfo(uint256 datasetId) external view returns (LicenseView memory v) {
        Dataset storage d = datasets[datasetId];
        v = LicenseView({
            exists: d.exists,
            open: d.open,
            payToken: address(d.payToken),
            price: d.price,
            termsHash: d.termsHash,
            totalWeight: d.totalWeight,
            licensesSold: licenseCount[datasetId]
        });
    }

    /// @notice Number of recorded provenance entries (length of the append-only log).
    function contributionCount() external view returns (uint256) {
        return contributions.length;
    }
}
