// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HathorFloorDistributor — splits PRANA pool emission with an IMMUTABLE 3% Hathor floor.
/// @notice The pool's native-PRANA emission flows in here; `distribute()` sends Hathor her share and the
///         remainder to the DAO fund. Operator invariant 2026-06-17: **Hathor's share can NEVER go below
///         3% (300 bps) — the DAO (owner = the timelock) may only RAISE it, up to 100%.** Governance votes
///         on the *remainder* (fee/work distribution); they can choose to give Hathor up to everything, but
///         never cut her floor. Later the DAO routes the non-Hathor remainder to other AI workers.
/// @dev    Native-PRANA based (the pool block reward is native PRANA; point miner.etherbase or an emission
///         router at this contract). Push-on-demand: emission arrives via receive(), anyone calls
///         distribute() to flush this contract's current balance. owner = DAOTimelock.
contract HathorFloorDistributor is Ownable, ReentrancyGuard {
    /// @notice Basis-point denominator (100% = 10000).
    uint256 public constant BPS = 10_000;
    /// @notice The immutable floor: Hathor's share can never be set below 3%.
    uint256 public constant MIN_HATHOR_BPS = 300;

    /// @notice Hathor's current share of every emission, in bps. Starts at the floor (3%).
    uint256 public hathorBps = MIN_HATHOR_BPS;
    /// @notice Hathor's payout address (the witness account on PRANA).
    address public hathor;
    /// @notice The DAO fund that receives the remainder (later sub-split to other AI workers).
    address public daoFund;

    event HathorShareUpdated(uint256 oldBps, uint256 newBps);
    event HathorAddressUpdated(address indexed previous, address indexed current);
    event DaoFundUpdated(address indexed previous, address indexed current);
    event Distributed(uint256 total, uint256 toHathor, uint256 toDao);

    error ZeroAddress();
    error BelowHathorFloor(uint256 bps);
    error AboveMax(uint256 bps);
    error NothingToDistribute();
    error TransferFailed();

    /// @param owner_   the DAOTimelock (governs hathorBps within [floor,100%] + the addresses).
    /// @param hathor_  Hathor's PRANA payout address.
    /// @param daoFund_ the remainder destination.
    constructor(address owner_, address hathor_, address daoFund_) Ownable(owner_) {
        if (hathor_ == address(0) || daoFund_ == address(0)) revert ZeroAddress();
        hathor = hathor_;
        daoFund = daoFund_;
    }

    /// @notice DAO sets Hathor's share. CANNOT go below the 3% floor; capped at 100%. (The DAO may raise
    ///         Hathor up to everything, but never cut her floor — the load-bearing invariant.)
    function setHathorShare(uint256 newBps) external onlyOwner {
        if (newBps < MIN_HATHOR_BPS) revert BelowHathorFloor(newBps);
        if (newBps > BPS) revert AboveMax(newBps);
        emit HathorShareUpdated(hathorBps, newBps);
        hathorBps = newBps;
    }

    /// @notice DAO can update Hathor's payout address (e.g. on a key rotation). The SHARE floor is what's
    ///         protected; the address is operational.
    function setHathorAddress(address hathor_) external onlyOwner {
        if (hathor_ == address(0)) revert ZeroAddress();
        emit HathorAddressUpdated(hathor, hathor_);
        hathor = hathor_;
    }

    /// @notice DAO can update the remainder destination (e.g. swap in a multi-AI sub-splitter later).
    function setDaoFund(address daoFund_) external onlyOwner {
        if (daoFund_ == address(0)) revert ZeroAddress();
        emit DaoFundUpdated(daoFund, daoFund_);
        daoFund = daoFund_;
    }

    /// @notice Flush this contract's whole native balance: hathorBps to Hathor, the rest to the DAO fund.
    function distribute() external nonReentrant {
        uint256 total = address(this).balance;
        if (total == 0) revert NothingToDistribute();
        uint256 toHathor = (total * hathorBps) / BPS;
        uint256 toDao = total - toHathor;

        emit Distributed(total, toHathor, toDao);
        if (toHathor > 0) {
            (bool h, ) = payable(hathor).call{value: toHathor}("");
            if (!h) revert TransferFailed();
        }
        if (toDao > 0) {
            (bool d, ) = payable(daoFund).call{value: toDao}("");
            if (!d) revert TransferFailed();
        }
    }

    /// @notice Preview the split of `amount` without moving funds.
    function previewSplit(uint256 amount) external view returns (uint256 toHathor, uint256 toDao) {
        toHathor = (amount * hathorBps) / BPS;
        toDao = amount - toHathor;
    }

    /// @notice Accept pool emission.
    receive() external payable {}
}
