// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BurnSink, BurnSinkBase, IProofOfBurnRegistryLike} from "../lib/BurnSink.sol";

/// @notice Test harness exposing {BurnSink} library fns + {BurnSinkBase} behavior. TEST ONLY.
contract BurnSinkHarness is BurnSinkBase {
    using BurnSink for IERC20;

    /// @notice Direct library call: burn tokens already held by this harness.
    function libSafeBurn(IERC20 token, uint256 amount) external returns (bool) {
        return token.safeBurn(amount);
    }

    /// @notice Direct library call: pull from `from` then sink.
    function libSinkFrom(IERC20 token, address from, uint256 amount) external returns (bool) {
        return token.sinkFrom(from, amount);
    }

    /// @notice Base-path sink with accounting + registry notification.
    function sink(IERC20 token, uint256 amount, bytes32 ref) external returns (bool) {
        return _sink(token, amount, ref);
    }

    /// @notice Base-path pull-then-sink with accounting + registry notification.
    function sinkFrom(IERC20 token, address from, uint256 amount, bytes32 ref) external returns (bool) {
        return _sinkFrom(token, from, amount, ref);
    }

    function setBurnRegistry(IProofOfBurnRegistryLike registry) external {
        _setBurnRegistry(registry);
    }
}

/// @notice Minimal registry mock recording recordBurn() calls (does NOT actually burnFrom). TEST ONLY.
contract MockBurnRegistry is IProofOfBurnRegistryLike {
    struct Note { address token; uint256 amount; bytes32 ref; }
    Note[] public notes;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function recordBurn(address token, uint256 amount, bytes32 ref) external returns (uint256 id) {
        require(!shouldRevert, "registry revert");
        id = notes.length;
        notes.push(Note(token, amount, ref));
    }

    function count() external view returns (uint256) {
        return notes.length;
    }
}
