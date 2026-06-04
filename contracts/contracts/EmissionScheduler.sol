// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMintable} from "./BurnMine.sol";

/// @title EmissionScheduler — per-epoch emission with optional halving, pushed to a distributor
/// @notice Mints `perEpoch` (optionally halving every `halvingEpochs`) for each elapsed epoch and
///         sends it to `recipient` (a gauge/distributor). Pull-based: anyone calls `mintDue()`.
///         The reward token must grant this contract minter authority. Bootstrap emission only —
///         every emission needs a paired sink downstream (faucet/sink discipline).
contract EmissionScheduler {
    IMintable public immutable token;
    address public immutable recipient;
    uint256 public immutable perEpoch;
    uint64 public immutable epochLength;
    uint64 public immutable halvingEpochs; // 0 = no halving
    uint64 public immutable start;

    uint64 public epochsMinted;
    uint256 public totalMinted;

    event Emitted(uint64 throughEpoch, uint256 amount);

    constructor(IMintable token_, address recipient_, uint256 perEpoch_, uint64 epochLength_, uint64 halvingEpochs_) {
        require(address(token_) != address(0) && recipient_ != address(0), "zero");
        require(perEpoch_ > 0 && epochLength_ > 0, "bad params");
        token = token_;
        recipient = recipient_;
        perEpoch = perEpoch_;
        epochLength = epochLength_;
        halvingEpochs = halvingEpochs_;
        start = uint64(block.timestamp);
    }

    function currentEpoch() public view returns (uint64) {
        return (uint64(block.timestamp) - start) / epochLength;
    }

    function emissionAt(uint64 epoch) public view returns (uint256) {
        if (halvingEpochs == 0) return perEpoch;
        uint64 halvings = epoch / halvingEpochs;
        if (halvings >= 256) return 0;
        return perEpoch >> halvings;
    }

    /// @notice Mint all unminted elapsed epochs to the recipient.
    function mintDue() external returns (uint256 minted) {
        uint64 cur = currentEpoch();
        for (uint64 e = epochsMinted; e < cur; e++) {
            minted += emissionAt(e);
        }
        require(minted > 0, "nothing due");
        epochsMinted = cur;
        totalMinted += minted;
        token.mint(recipient, minted);
        emit Emitted(cur, minted);
    }
}
