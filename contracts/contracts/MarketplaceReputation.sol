// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MarketplaceReputation — a value-ladder trust-tier + reputation layer for sellers.
/// @notice Sits alongside {RoyaltyMarketplace} / {Escrow}. Each seller accrues a reputation
///         score from SETTLED sales and loses score on DISPUTED ones; a seller's TRUST TIER
///         (NEW → VERIFIED → TRUSTED → ELITE) is derived from that score plus any posted bond.
///         Tiers gate marketplace privileges: a per-tier listing-price cap, a per-tier escrow
///         hold (basis points the marketplace withholds / time it locks), and featured-listing
///         eligibility. The marketplace/escrow reports trade outcomes through a role-gated hook;
///         this contract never moves the trade's funds — it only keeps the reputation ledger and
///         optionally custodies a seller's anti-fraud bond, which an arbiter can slash on proven
///         fraud.
/// @dev    Pure accounting + bond custody. It holds no listings and no trade proceeds. The
///         marketplace is expected to hold `REPORTER_ROLE` (to push sale/dispute outcomes) and
///         to READ {tierOf} / {listingCapOf} / {escrowHoldBpsOf} / {isFeatureEligible} when it
///         enforces caps. Tier thresholds and per-tier privileges are admin-governed (the DAO
///         timelock should hold `DEFAULT_ADMIN_ROLE`). Bond slashing is `SLASHER_ROLE`-gated and
///         routes the slashed amount to an admin-set sink (e.g. a burn address / treasury).
contract MarketplaceReputation is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice May report settled / disputed trade outcomes (the marketplace / escrow).
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    /// @notice May slash a seller's posted bond on proven fraud (an arbiter / dispute DAO).
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    uint16 public constant BPS_DENOM = 10000;

    /// @notice The trust ladder. Higher ordinal = more privilege.
    enum Tier {
        New, // 0 - default, untrusted
        Verified, // 1
        Trusted, // 2
        Elite // 3
    }

    uint256 internal constant TIER_COUNT = 4;

    /// @notice Per-seller reputation record.
    struct Seller {
        uint64 settledSales; // count of settled (good) sales
        uint64 disputes; // count of disputed (bad) outcomes
        uint128 score; // current reputation score (monotone via the +/- weights, floored at 0)
        IERC20 bondToken; // token the bond is posted in (address(0) = no bond)
        uint256 bond; // bonded amount currently held in custody
        Tier tier; // cached tier (recomputed on every score/bond change)
    }

    /// @notice Privilege bundle gated by a tier.
    struct TierConfig {
        uint256 scoreThreshold; // minimum score to reach this tier (tier New is implicitly 0)
        uint256 minBond; // minimum posted bond (in `bondToken`) required for this tier
        uint256 listingCap; // max per-listing price the marketplace should allow (0 = unlimited)
        uint16 escrowHoldBps; // escrow hold the marketplace should apply for this tier
        bool featured; // whether this tier may post featured listings
    }

    /// @notice Points added to score per settled sale.
    uint128 public scorePerSale;
    /// @notice Points removed from score per dispute.
    uint128 public scorePerDispute;
    /// @notice Where slashed bonds are sent (e.g. a burn address or the treasury).
    address public slashSink;

    /// @dev seller => record.
    mapping(address => Seller) private _sellers;
    /// @dev tier ordinal => config.
    mapping(Tier => TierConfig) private _tierConfig;

    event ReputationUpdated(
        address indexed seller,
        bool indexed settled,
        uint256 newScore,
        uint64 settledSales,
        uint64 disputes
    );
    event TierChanged(address indexed seller, Tier indexed oldTier, Tier indexed newTier);
    event Bonded(address indexed seller, address indexed token, uint256 amount, uint256 newBond);
    event BondWithdrawn(address indexed seller, uint256 amount, uint256 newBond);
    event Slashed(address indexed seller, uint256 amount, address indexed to, bytes32 reason);
    event TierConfigSet(
        Tier indexed tier,
        uint256 scoreThreshold,
        uint256 minBond,
        uint256 listingCap,
        uint16 escrowHoldBps,
        bool featured
    );
    event ScoringSet(uint128 scorePerSale, uint128 scorePerDispute);
    event SlashSinkSet(address indexed sink);

    error ZeroAddress();
    error ZeroAmount();
    error BadBps(uint16 bps);
    error BadTier();
    error NoBond();
    error BondTokenMismatch(address have, address want);
    error InsufficientBond(uint256 have, uint256 want);
    error SlashSinkUnset();

    /// @param admin Receives `DEFAULT_ADMIN_ROLE`, `REPORTER_ROLE` and `SLASHER_ROLE` to bootstrap.
    /// @param _scorePerSale Score awarded per settled sale.
    /// @param _scorePerDispute Score removed per dispute.
    constructor(address admin, uint128 _scorePerSale, uint128 _scorePerDispute) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REPORTER_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);

        scorePerSale = _scorePerSale;
        scorePerDispute = _scorePerDispute;
        emit ScoringSet(_scorePerSale, _scorePerDispute);

        // Sensible default ladder; the admin/DAO can re-tune any tier later.
        // New is implicitly threshold 0 / no privileges beyond the baseline.
        _setTierConfig(Tier.Verified, 100, 0, 0, 1000, false);
        _setTierConfig(Tier.Trusted, 500, 0, 0, 500, true);
        _setTierConfig(Tier.Elite, 2000, 0, 0, 250, true);
    }

    // --------------------------------------------------------------------- //
    // Reporting hook (marketplace / escrow → here)                          //
    // --------------------------------------------------------------------- //

    /// @notice Report a SETTLED (successful) sale for `seller`. Raises reputation.
    /// @dev Called by the marketplace/escrow after a clean settlement. Re-derives the tier.
    function reportSale(address seller) external onlyRole(REPORTER_ROLE) {
        if (seller == address(0)) revert ZeroAddress();
        Seller storage s = _sellers[seller];

        unchecked {
            s.settledSales += 1;
        }
        // score is uint128; scorePerSale is uint128 — saturate is impractical here, accept growth.
        s.score += scorePerSale;

        emit ReputationUpdated(seller, true, s.score, s.settledSales, s.disputes);
        _resyncTier(seller, s);
    }

    /// @notice Report a DISPUTED (failed/refunded-against-seller) outcome for `seller`.
    /// @dev Lowers reputation; score floors at 0 (never underflows). Re-derives the tier.
    function reportDispute(address seller) external onlyRole(REPORTER_ROLE) {
        if (seller == address(0)) revert ZeroAddress();
        Seller storage s = _sellers[seller];

        unchecked {
            s.disputes += 1;
        }
        uint128 pen = scorePerDispute;
        s.score = s.score > pen ? s.score - pen : 0;

        emit ReputationUpdated(seller, false, s.score, s.settledSales, s.disputes);
        _resyncTier(seller, s);
    }

    // --------------------------------------------------------------------- //
    // Seller bond (anti-fraud stake)                                        //
    // --------------------------------------------------------------------- //

    /// @notice Post (or top up) an anti-fraud bond. A higher tier may require a minimum bond.
    /// @dev The first bond fixes the bond token; later top-ups must use the same token. Pulls
    ///      `amount` from the caller (who must have approved this contract).
    function postBond(IERC20 token, uint256 amount) external {
        if (address(token) == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Seller storage s = _sellers[msg.sender];
        if (s.bond == 0) {
            s.bondToken = token;
        } else if (address(s.bondToken) != address(token)) {
            revert BondTokenMismatch(address(s.bondToken), address(token));
        }

        s.bond += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Bonded(msg.sender, address(token), amount, s.bond);
        _resyncTier(msg.sender, s);
    }

    /// @notice Withdraw part of your own bond. If the withdrawal would drop you below the
    ///         current tier's `minBond`, your tier is recomputed downward accordingly.
    function withdrawBond(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Seller storage s = _sellers[msg.sender];
        if (s.bond == 0) revert NoBond();
        if (amount > s.bond) revert InsufficientBond(s.bond, amount);

        s.bond -= amount;
        IERC20 token = s.bondToken;
        if (s.bond == 0) {
            s.bondToken = IERC20(address(0));
        }
        token.safeTransfer(msg.sender, amount);

        emit BondWithdrawn(msg.sender, amount, s.bond);
        _resyncTier(msg.sender, s);
    }

    /// @notice Slash up to `amount` of `seller`'s bond on proven fraud, routing it to {slashSink}.
    /// @dev SLASHER_ROLE-gated (arbiter / dispute DAO). Slashing also re-derives the tier (a
    ///      slashed seller can drop below a tier's `minBond`). `reason` is an opaque tag for audit.
    function slash(address seller, uint256 amount, bytes32 reason) external onlyRole(SLASHER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        address sink = slashSink;
        if (sink == address(0)) revert SlashSinkUnset();

        Seller storage s = _sellers[seller];
        if (s.bond == 0) revert NoBond();
        if (amount > s.bond) revert InsufficientBond(s.bond, amount);

        s.bond -= amount;
        IERC20 token = s.bondToken;
        if (s.bond == 0) {
            s.bondToken = IERC20(address(0));
        }
        token.safeTransfer(sink, amount);

        emit Slashed(seller, amount, sink, reason);
        _resyncTier(seller, s);
    }

    // --------------------------------------------------------------------- //
    // Admin configuration                                                    //
    // --------------------------------------------------------------------- //

    /// @notice Set the +/- score weights applied per sale / dispute.
    function setScoring(uint128 _scorePerSale, uint128 _scorePerDispute)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        scorePerSale = _scorePerSale;
        scorePerDispute = _scorePerDispute;
        emit ScoringSet(_scorePerSale, _scorePerDispute);
    }

    /// @notice Configure the privilege bundle + thresholds for a tier (tier `New` is fixed baseline).
    function setTierConfig(
        Tier tier,
        uint256 scoreThreshold,
        uint256 minBond,
        uint256 listingCap,
        uint16 escrowHoldBps,
        bool featured
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTierConfig(tier, scoreThreshold, minBond, listingCap, escrowHoldBps, featured);
    }

    /// @notice Set where slashed bonds are routed (burn address / treasury).
    function setSlashSink(address sink) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (sink == address(0)) revert ZeroAddress();
        slashSink = sink;
        emit SlashSinkSet(sink);
    }

    function _setTierConfig(
        Tier tier,
        uint256 scoreThreshold,
        uint256 minBond,
        uint256 listingCap,
        uint16 escrowHoldBps,
        bool featured
    ) internal {
        if (tier == Tier.New) revert BadTier(); // baseline tier is not configurable
        if (escrowHoldBps > BPS_DENOM) revert BadBps(escrowHoldBps);
        _tierConfig[tier] = TierConfig({
            scoreThreshold: scoreThreshold,
            minBond: minBond,
            listingCap: listingCap,
            escrowHoldBps: escrowHoldBps,
            featured: featured
        });
        emit TierConfigSet(tier, scoreThreshold, minBond, listingCap, escrowHoldBps, featured);
    }

    // --------------------------------------------------------------------- //
    // Tier derivation + privilege views (the marketplace reads these)        //
    // --------------------------------------------------------------------- //

    /// @dev Recompute the cached tier from current score + bond; emit on change.
    function _resyncTier(address seller, Seller storage s) internal {
        Tier next = _deriveTier(s.score, s.bond);
        if (next != s.tier) {
            Tier old = s.tier;
            s.tier = next;
            emit TierChanged(seller, old, next);
        }
    }

    /// @dev Highest tier whose `scoreThreshold` AND `minBond` are both satisfied. Tiers are
    ///      checked top-down; a tier is only awarded if every lower tier's gate is also met,
    ///      which is guaranteed when thresholds are monotone non-decreasing (the admin should
    ///      keep them so). We scan from the top and return the first fully-satisfied tier.
    function _deriveTier(uint256 score, uint256 bond) internal view returns (Tier) {
        for (uint256 i = TIER_COUNT; i > 1; ) {
            unchecked {
                --i;
            }
            Tier t = Tier(i);
            TierConfig storage c = _tierConfig[t];
            if (score >= c.scoreThreshold && bond >= c.minBond) {
                return t;
            }
        }
        return Tier.New;
    }

    /// @notice Current trust tier for `seller`.
    function tierOf(address seller) external view returns (Tier) {
        return _sellers[seller].tier;
    }

    /// @notice The tier `seller` WOULD hold given current state (live recompute, ignores cache).
    function liveTierOf(address seller) external view returns (Tier) {
        Seller storage s = _sellers[seller];
        return _deriveTier(s.score, s.bond);
    }

    /// @notice Full seller record (score, counts, bond, cached tier).
    function sellerInfo(address seller)
        external
        view
        returns (
            uint64 settledSales,
            uint64 disputes,
            uint128 score,
            address bondToken,
            uint256 bond,
            Tier tier
        )
    {
        Seller storage s = _sellers[seller];
        return (s.settledSales, s.disputes, s.score, address(s.bondToken), s.bond, s.tier);
    }

    /// @notice Per-listing price cap the marketplace should enforce for `seller` (0 = unlimited).
    function listingCapOf(address seller) external view returns (uint256) {
        return _tierConfig[_sellers[seller].tier].listingCap;
    }

    /// @notice Escrow-hold basis points the marketplace should apply for `seller`.
    function escrowHoldBpsOf(address seller) external view returns (uint16) {
        return _tierConfig[_sellers[seller].tier].escrowHoldBps;
    }

    /// @notice Whether `seller`'s current tier may post featured listings.
    function isFeatureEligible(address seller) external view returns (bool) {
        return _tierConfig[_sellers[seller].tier].featured;
    }

    /// @notice Read a tier's configured privilege bundle.
    function tierConfig(Tier tier) external view returns (TierConfig memory) {
        return _tierConfig[tier];
    }
}
