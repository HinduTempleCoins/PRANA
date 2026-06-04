// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Handles binary fixed point numbers (https://en.wikipedia.org/wiki/Q_(number_format)).
/// @dev Ported from Uniswap V2 core. range: [0, 2**112 - 1], resolution: 1 / 2**112.
///      The encode/uqdiv operations rely on the original 0.5.16 wrapping semantics; under
///      0.8.x checked arithmetic they would not overflow for valid inputs, but the
///      accumulator addition that consumes these (in the Pair) is wrapped in `unchecked`
///      to preserve the canonical overflow-tolerant price-accumulator behavior.
library UQ112x112 {
    uint224 constant Q112 = 2 ** 112;

    // encode a uint112 as a UQ112x112
    function encode(uint112 y) internal pure returns (uint224 z) {
        unchecked {
            z = uint224(y) * Q112; // never overflows: uint112 * 2**112 fits in uint224
        }
    }

    // divide a UQ112x112 by a uint112, returning a UQ112x112
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
