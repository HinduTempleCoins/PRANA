// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RewardsDistributorMerkleEpoch — weekly Merkle-root reward claims (Curve/Hop style)
/// @notice The admin posts ONE Merkle root per epoch (epoch = block.timestamp / epochLength) along
///         with a funded reward `amount` that must already sit in this contract. Each epoch is an
///         independent airdrop: leaves are keccak256(bytes.concat(keccak256(abi.encode(index,
///         account, amount)))) — the OpenZeppelin StandardMerkleTree double-hash scheme, identical
///         to {MerkleDistributor}. A given (epoch, index) is single-use. Roots are IMMUTABLE once
///         posted (no re-posting / overwriting an epoch). After `graceEpochs` epochs have fully
///         elapsed past an epoch, the admin may sweep that epoch's unclaimed remainder.
/// @dev "Funded amount" is bookkeeping only: it records how much the admin earmarked for the epoch
///      and bounds the sweepable remainder per epoch. Claims pull from the contract's live token
///      balance via SafeERC20, so the admin is responsible for keeping the contract solvent.
contract RewardsDistributorMerkleEpoch is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    /// @notice Seconds per epoch (e.g. 1 weeks). epoch index = timestamp / epochLength.
    uint256 public immutable epochLength;
    /// @notice How many whole epochs must elapse PAST an epoch before its remainder is sweepable.
    uint256 public immutable graceEpochs;

    struct Epoch {
        bytes32 root;     // immutable once non-zero
        uint256 funded;   // earmarked reward amount (bookkeeping / sweep bound)
        uint256 claimed;  // total claimed from this epoch so far
        bool swept;       // remainder reclaimed by admin
    }
    /// @notice epoch index => epoch data.
    mapping(uint256 => Epoch) public epochs;
    /// @notice epoch index => claim index => claimed flag.
    mapping(uint256 => mapping(uint256 => bool)) public isClaimed;

    event EpochPosted(uint256 indexed epoch, bytes32 root, uint256 funded);
    event Claimed(uint256 indexed epoch, uint256 indexed index, address indexed account, uint256 amount);
    event Swept(uint256 indexed epoch, address indexed to, uint256 amount);

    error ZeroAddress();
    error BadParams();
    error RootExists();
    error ZeroRoot();
    error NoRoot();
    error AlreadyClaimed();
    error BadProof();
    error GraceNotElapsed();
    error AlreadySwept();
    error LengthMismatch();
    error NothingToSweep();

    constructor(IERC20 token_, uint256 epochLength_, uint256 graceEpochs_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (epochLength_ == 0) revert BadParams();
        token = token_;
        epochLength = epochLength_;
        graceEpochs = graceEpochs_;
    }

    /// @notice The current epoch index for the present block timestamp.
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLength;
    }

    /// @notice Post the immutable Merkle root + funded amount for `epoch`. Fund the contract
    ///         (transfer `funded` of `token` to it) separately; this only records the earmark.
    /// @dev Reverts if a root was already posted for the epoch (immutability) or if root is zero.
    function postEpoch(uint256 epoch, bytes32 root, uint256 funded) external onlyOwner {
        if (root == bytes32(0)) revert ZeroRoot();
        Epoch storage e = epochs[epoch];
        if (e.root != bytes32(0)) revert RootExists();
        e.root = root;
        e.funded = funded;
        emit EpochPosted(epoch, root, funded);
    }

    /// @notice Claim allocation `amount` at `index` for `account` in `epoch` against its posted root.
    /// @dev Single-use per (epoch, index). Anyone may submit the proof; tokens go to `account`.
    function claim(uint256 epoch, uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        public
    {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert NoRoot();
        if (isClaimed[epoch][index]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verify(proof, e.root, leaf)) revert BadProof();

        isClaimed[epoch][index] = true;
        e.claimed += amount;
        token.safeTransfer(account, amount);
        emit Claimed(epoch, index, account, amount);
    }

    /// @notice Batch-claim across multiple epochs in one transaction. All array lengths must match;
    ///         each element is one (epoch, index, account, amount, proof) claim.
    function batchClaim(
        uint256[] calldata epochList,
        uint256[] calldata indexes,
        address[] calldata accounts,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external {
        uint256 n = epochList.length;
        if (indexes.length != n || accounts.length != n || amounts.length != n || proofs.length != n) {
            revert LengthMismatch();
        }
        for (uint256 i = 0; i < n; i++) {
            claim(epochList[i], indexes[i], accounts[i], amounts[i], proofs[i]);
        }
    }

    /// @notice True once `epoch` is old enough (graceEpochs whole epochs past) to sweep.
    function isSweepable(uint256 epoch) public view returns (bool) {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0) || e.swept) return false;
        return currentEpoch() > epoch + graceEpochs;
    }

    /// @notice After the grace period, the admin reclaims `epoch`'s unclaimed remainder to `to`.
    /// @dev Remainder = funded - claimed (floored at 0). Marks the epoch swept so it can't repeat.
    function sweep(uint256 epoch, address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert NoRoot();
        if (e.swept) revert AlreadySwept();
        if (currentEpoch() <= epoch + graceEpochs) revert GraceNotElapsed();

        amount = e.claimed >= e.funded ? 0 : e.funded - e.claimed;
        if (amount == 0) revert NothingToSweep();

        e.swept = true;
        token.safeTransfer(to, amount);
        emit Swept(epoch, to, amount);
    }
}
