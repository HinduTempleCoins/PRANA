// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LandPortalRegistry — land-as-portal parcels that earn from traffic, not flipping
/// @notice Each parcel is an ERC-721. Its owner points the parcel at a `destinationRef`
///         (an opaque bytes32 route the front-end resolves into a scene/url/zone) chosen from
///         an admin-approved allowlist of destinations — so owners cannot route visitors to
///         arbitrary off-list targets. A trusted game server (TRAFFIC_ORACLE_ROLE) posts the
///         number of visits each parcel received in an epoch. Anyone can fund a reward pool;
///         each epoch's funded amount is split pro-rata to that epoch's per-parcel traffic.
///         Rewards are pull-based, accumulator-style (like DividendDistributor): each epoch
///         locks in a per-visit rate (`epochPerVisit`) over that epoch's total posted visits,
///         and a parcel claims `sum over epochs of (its visits that epoch * that epoch's rate)`.
/// @dev    Funding accrues into `pendingPool` until {finalizeEpoch} converts it to a per-visit
///         rate for the epoch's posted visits. A parcel's visits are pooled per-epoch
///         (`openVisits` tagged with `openEpoch`) and rated only once that epoch is finalized,
///         so each epoch's pool pays ONLY that epoch's traffic — no cross-epoch double counting.
///         Parcels earn purely from being visited, never from flipping.
contract LandPortalRegistry is ERC721, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant TRAFFIC_ORACLE_ROLE = keccak256("TRAFFIC_ORACLE_ROLE");

    /// @dev Accumulator scaling factor (reward-per-visit is scaled by ACC).
    uint256 private constant ACC = 1e18;

    /// @notice The ERC-20 the reward pool is denominated in.
    IERC20 public immutable rewardToken;

    /// @notice Current (open) epoch index (incremented when an epoch is finalized).
    uint256 public epoch;

    /// @notice Reward funds received but not yet attributed to an epoch's traffic.
    uint256 public pendingPool;

    /// @notice Reward-per-visit (scaled by ACC) locked in for each finalized epoch.
    /// @dev epoch index => per-visit rate. Visits posted in epoch e earn `epochPerVisit[e]`.
    mapping(uint256 => uint256) public epochPerVisit;

    /// @notice Admin-approved destination allowlist. Owners may only point at approved refs.
    mapping(bytes32 => bool) public approvedDestination;

    struct Parcel {
        bytes32 destinationRef; // current route; bytes32(0) = unset
        uint256 totalVisits;    // lifetime visits (informational)
        uint256 openVisits;     // visits accrued in `openEpoch`, not yet rated
        uint256 openEpoch;      // the epoch `openVisits` were accrued in
        uint256 pending;        // crystallized, claimable reward (rated, unclaimed)
    }

    /// @dev tokenId => parcel state.
    mapping(uint256 => Parcel) public parcels;

    event ParcelMinted(uint256 indexed tokenId, address indexed to);
    event DestinationApproved(bytes32 indexed destinationRef, bool approved);
    event DestinationSet(uint256 indexed tokenId, bytes32 indexed destinationRef);
    event PoolFunded(address indexed from, uint256 amount, uint256 pendingPool);
    event TrafficPosted(uint256 indexed epoch, uint256 indexed tokenId, uint256 visits);
    event EpochFinalized(uint256 indexed epoch, uint256 totalVisits, uint256 distributed);
    event RewardClaimed(uint256 indexed tokenId, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotParcelOwner(uint256 tokenId);
    error UnknownParcel(uint256 tokenId);
    error DestinationNotApproved(bytes32 destinationRef);
    error ZeroAmount();
    error LengthMismatch();
    error NoPendingPool();
    error NoTraffic();

    /// @param name_ ERC-721 collection name.
    /// @param symbol_ ERC-721 collection symbol.
    /// @param rewardToken_ ERC-20 reward token (funded by anyone via {fundPool}).
    /// @param admin Address granted DEFAULT_ADMIN_ROLE, ADMIN_ROLE and TRAFFIC_ORACLE_ROLE.
    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 rewardToken_,
        address admin
    ) ERC721(name_, symbol_) {
        if (address(rewardToken_) == address(0) || admin == address(0)) revert ZeroAddress();
        rewardToken = rewardToken_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(TRAFFIC_ORACLE_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //  Parcel issuance & destinations                                       //
    // --------------------------------------------------------------------- //

    /// @notice Mint a parcel to `to`. Admin-only (land is issued, not freely minted).
    function mintParcel(address to, uint256 tokenId) external onlyRole(ADMIN_ROLE) {
        _safeMint(to, tokenId);
        emit ParcelMinted(tokenId, to);
    }

    /// @notice Approve (or revoke) a destination ref that parcel owners may point at.
    function setDestinationApproval(bytes32 destinationRef, bool approved)
        external
        onlyRole(ADMIN_ROLE)
    {
        approvedDestination[destinationRef] = approved;
        emit DestinationApproved(destinationRef, approved);
    }

    /// @notice Point a parcel you own at an approved destination ref.
    /// @dev Reverts if the caller is not the parcel owner or the ref is not on the allowlist.
    function setDestination(uint256 tokenId, bytes32 destinationRef) external {
        if (_ownerOf(tokenId) != msg.sender) revert NotParcelOwner(tokenId);
        if (!approvedDestination[destinationRef]) revert DestinationNotApproved(destinationRef);
        parcels[tokenId].destinationRef = destinationRef;
        emit DestinationSet(tokenId, destinationRef);
    }

    /// @notice The route a parcel currently points at (front-end resolves it).
    function destinationOf(uint256 tokenId) external view returns (bytes32) {
        return parcels[tokenId].destinationRef;
    }

    // --------------------------------------------------------------------- //
    //  Reward pool funding                                                  //
    // --------------------------------------------------------------------- //

    /// @notice Fund the reward pool. The amount sits in `pendingPool` until an epoch is
    ///         finalized, then is split pro-rata to that epoch's traffic. Anyone may fund.
    function fundPool(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        pendingPool += amount;
        emit PoolFunded(msg.sender, amount, pendingPool);
    }

    // --------------------------------------------------------------------- //
    //  Traffic accounting (oracle)                                          //
    // --------------------------------------------------------------------- //

    /// @notice Post per-parcel visit counts for the current open epoch. Oracle-only.
    /// @dev A parcel's visits are pooled per-epoch in `openVisits` (tagged with `openEpoch`).
    ///      They are rated only when that epoch is finalized — at which point a later touch
    ///      (more traffic, or a claim) folds `openVisits * epochPerVisit[openEpoch]` into the
    ///      parcel's claimable `pending`. So each epoch's pool only ever pays that epoch's
    ///      visits — no cross-epoch double counting.
    /// @param tokenIds Parcels that received traffic.
    /// @param visits   Visit counts, parallel to `tokenIds`.
    function postTraffic(uint256[] calldata tokenIds, uint256[] calldata visits)
        external
        onlyRole(TRAFFIC_ORACLE_ROLE)
        returns (uint256 added)
    {
        if (tokenIds.length != visits.length) revert LengthMismatch();
        uint256 ep = epoch;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            uint256 v = visits[i];
            if (_ownerOf(id) == address(0)) revert UnknownParcel(id);
            if (v == 0) continue;
            Parcel storage p = parcels[id];
            _settle(p, ep);            // fold any prior finalized epoch's visits into pending
            p.openVisits += v;
            p.totalVisits += v;
            added += v;
            emit TrafficPosted(ep, id, v);
        }
        if (added > 0) {
            _epochVisits += added;
        }
    }

    /// @dev Total visits posted in the current (not-yet-finalized) epoch.
    uint256 private _epochVisits;

    /// @notice Visits accumulated in the current open epoch.
    function currentEpochVisits() external view returns (uint256) {
        return _epochVisits;
    }

    /// @notice Finalize the current epoch: lock in a per-visit rate over the epoch's posted
    ///         visits and open the next epoch. Oracle-only.
    /// @dev Reverts if there is nothing to distribute or no traffic was posted this epoch.
    function finalizeEpoch() external onlyRole(TRAFFIC_ORACLE_ROLE) returns (uint256 distributed) {
        uint256 totalVisits = _epochVisits;
        if (totalVisits == 0) revert NoTraffic();
        uint256 pool = pendingPool;
        if (pool == 0) revert NoPendingPool();

        uint256 ep = epoch;
        uint256 perVisit = (pool * ACC) / totalVisits;
        epochPerVisit[ep] = perVisit;
        // Only the exactly-distributable amount leaves pendingPool; integer-division dust
        // stays pooled for the next epoch (never stranded).
        distributed = (perVisit * totalVisits) / ACC;
        pendingPool = pool - distributed;

        epoch = ep + 1;
        _epochVisits = 0;
        emit EpochFinalized(ep, totalVisits, distributed);
    }

    // --------------------------------------------------------------------- //
    //  Claims                                                               //
    // --------------------------------------------------------------------- //

    /// @dev Fold a parcel's now-finalized open-epoch visits into `pending`. A no-op while the
    ///      parcel's open visits belong to the still-open epoch (rate not yet known).
    function _settle(Parcel storage p, uint256 currentEpoch) internal {
        if (p.openVisits > 0 && p.openEpoch < currentEpoch) {
            p.pending += (p.openVisits * epochPerVisit[p.openEpoch]) / ACC;
            p.openVisits = 0;
        }
        p.openEpoch = currentEpoch;
    }

    /// @notice Reward claimable by a parcel as of the latest finalized epoch.
    function claimable(uint256 tokenId) public view returns (uint256) {
        Parcel storage p = parcels[tokenId];
        uint256 amount = p.pending;
        if (p.openVisits > 0 && p.openEpoch < epoch) {
            amount += (p.openVisits * epochPerVisit[p.openEpoch]) / ACC;
        }
        return amount;
    }

    /// @notice Claim a parcel's accrued traffic rewards to its current owner. Owner-only.
    function claim(uint256 tokenId) external returns (uint256 amount) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert UnknownParcel(tokenId);
        if (owner != msg.sender) revert NotParcelOwner(tokenId);

        Parcel storage p = parcels[tokenId];
        _settle(p, epoch);
        amount = p.pending;
        if (amount == 0) revert ZeroAmount();
        p.pending = 0;

        rewardToken.safeTransfer(owner, amount);
        emit RewardClaimed(tokenId, owner, amount);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
