// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title WeightedRandomDraw
/// @notice Pure helpers for weighted random selection from a discrete table, usable with any
///         entropy word (a future blockhash, a VRF word, a seeded mock — see
///         {IRandomnessSource}). Gacha, farm-loot and arcade modules all share this so odds
///         math lives in exactly one audited place.
/// @dev The core trick: precompute a cumulative-weight array off-chain or via {cumulative},
///      then {drawFromCumulative} does an O(log n) binary search instead of the O(n) linear
///      scan used by simpler pickers. {draw} is the convenience O(n) form for small tables.
library WeightedRandomDraw {
    error EmptyTable();
    error ZeroTotalWeight();
    error NotStrictlyIncreasing();

    /// @notice Select an index in [0, weights.length) with probability weights[i]/sum(weights).
    /// @dev O(n) linear scan; fine for small tables. `entropy` may be any 256-bit word.
    /// @param weights Per-outcome weights (at least one must be non-zero).
    /// @param entropy A random 256-bit word.
    /// @return index The selected outcome index.
    function draw(uint256[] memory weights, uint256 entropy)
        internal
        pure
        returns (uint256 index)
    {
        uint256 len = weights.length;
        if (len == 0) revert EmptyTable();

        uint256 total;
        for (uint256 i = 0; i < len; i++) {
            total += weights[i];
        }
        if (total == 0) revert ZeroTotalWeight();

        uint256 roll = entropy % total;
        uint256 cursor;
        for (uint256 i = 0; i < len; i++) {
            cursor += weights[i];
            if (roll < cursor) {
                return i;
            }
        }
        // Unreachable: roll < total always lands inside the loop.
        return len - 1;
    }

    /// @notice Build the cumulative-weight array from per-outcome weights.
    /// @dev cum[i] = sum(weights[0..i]); cum[len-1] is the total weight. Reverts on an
    ///      all-zero table. Outcomes with weight 0 are allowed (never selected) as long as
    ///      the total is non-zero.
    function cumulative(uint256[] memory weights)
        internal
        pure
        returns (uint256[] memory cum)
    {
        uint256 len = weights.length;
        if (len == 0) revert EmptyTable();
        cum = new uint256[](len);
        uint256 acc;
        for (uint256 i = 0; i < len; i++) {
            acc += weights[i];
            cum[i] = acc;
        }
        if (acc == 0) revert ZeroTotalWeight();
    }

    /// @notice Select an index from a precomputed strictly-non-decreasing cumulative-weight
    ///         array using binary search. O(log n).
    /// @dev `cum` MUST be non-decreasing with cum[last] == total weight (as produced by
    ///      {cumulative}). The result is the first index i such that roll < cum[i], where
    ///      roll = entropy % total. Zero-weight outcomes (flat segments) are correctly never
    ///      selected because their predecessor's cum value already exceeds any roll that
    ///      could map to them.
    /// @param cum Cumulative-weight array (last element = total weight).
    /// @param entropy A random 256-bit word.
    /// @return index The selected outcome index.
    function drawFromCumulative(uint256[] memory cum, uint256 entropy)
        internal
        pure
        returns (uint256 index)
    {
        uint256 len = cum.length;
        if (len == 0) revert EmptyTable();
        uint256 total = cum[len - 1];
        if (total == 0) revert ZeroTotalWeight();

        uint256 roll = entropy % total;

        // Binary search for the smallest index i with roll < cum[i].
        uint256 lo = 0;
        uint256 hi = len - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (roll < cum[mid]) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        return lo;
    }

    /// @notice Derive a fresh entropy word from a base word and a draw index.
    /// @dev Lets a caller pull many independent draws from a single random word, e.g. a VRF
    ///      fulfillment, without re-requesting: `entropyAt(word, k)` for k = 0,1,2,...
    function entropyAt(uint256 baseWord, uint256 nonce) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(baseWord, nonce)));
    }
}
