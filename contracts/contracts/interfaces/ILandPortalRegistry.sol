// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ILandPortalRegistry — parcels (ERC-721) that route to approved destinations and earn
///         per-visit rewards from an epoch-finalized traffic oracle.
/// @notice External surface of {LandPortalRegistry}: admins mint parcels and approve destination
///         refs; parcel owners point their parcel at an approved destination; anyone funds the
///         reward pool; a traffic oracle posts visit counts and finalizes epochs (which prices
///         that epoch's visits against the pool); owners claim accrued rewards.
/// @dev Declares only the registry-specific surface; the implementation also exposes the standard
///      ERC-721 functions.
interface ILandPortalRegistry {
    event ParcelMinted(uint256 indexed tokenId, address indexed to);
    event DestinationApproved(bytes32 indexed destinationRef, bool approved);
    event DestinationSet(uint256 indexed tokenId, bytes32 indexed destinationRef);
    event PoolFunded(address indexed from, uint256 amount, uint256 pendingPool);
    event TrafficPosted(uint256 indexed epoch, uint256 indexed tokenId, uint256 visits);
    event EpochFinalized(uint256 indexed epoch, uint256 totalVisits, uint256 distributed);
    event RewardClaimed(uint256 indexed tokenId, address indexed to, uint256 amount);

    function rewardToken() external view returns (address);
    function epoch() external view returns (uint256);
    function pendingPool() external view returns (uint256);
    function epochPerVisit(uint256 epoch_) external view returns (uint256);
    function approvedDestination(bytes32 destinationRef) external view returns (bool);
    function parcels(uint256 tokenId)
        external
        view
        returns (
            bytes32 destinationRef,
            uint256 totalVisits,
            uint256 openVisits,
            uint256 openEpoch,
            uint256 pending
        );

    // --- admin / oracle --------------------------------------------------- //
    function mintParcel(address to, uint256 tokenId) external;
    function setDestinationApproval(bytes32 destinationRef, bool approved) external;
    function postTraffic(uint256[] calldata tokenIds, uint256[] calldata visits) external returns (uint256 added);
    function finalizeEpoch() external returns (uint256 distributed);

    // --- owner / public --------------------------------------------------- //
    function setDestination(uint256 tokenId, bytes32 destinationRef) external;
    function fundPool(uint256 amount) external;
    function claim(uint256 tokenId) external returns (uint256 amount);

    // --- views ------------------------------------------------------------ //
    function destinationOf(uint256 tokenId) external view returns (bytes32);
    function currentEpochVisits() external view returns (uint256);
    function claimable(uint256 tokenId) external view returns (uint256);
}
