// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FixtureERC20, FixtureERC721, FixtureMintableERC20} from "./Fixtures.sol";
import {Test} from "forge-std/Test.sol";

/// @title BaseTest — shared setUp conveniences for PRANA forge tests.
/// @notice Provides common labelled actors, mock-deploy helpers, and thin wrappers over the
///         forge cheatcodes for time travel so individual tests read clearly. Extend this
///         instead of forge-std `Test` directly.
abstract contract BaseTest is Test {
    // ---- Common actors (deterministic, labelled in traces) ----
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal treasury = makeAddr("treasury");

    /// @dev Override-able base setUp; concrete tests call `super.setUp()` then add their own wiring.
    function setUp() public virtual {
        // Give actors a little native balance for any value-bearing calls.
        vm.deal(admin, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ---- Mock deploy helpers ----

    /// @notice Deploy an open mintable/burnable ERC-20 (18 decimals).
    function deployERC20(string memory name_, string memory symbol_) internal returns (FixtureERC20) {
        return new FixtureERC20(name_, symbol_, 18);
    }

    /// @notice Deploy an open mintable/burnable ERC-20 with custom decimals.
    function deployERC20(string memory name_, string memory symbol_, uint8 decimals_) internal returns (FixtureERC20) {
        return new FixtureERC20(name_, symbol_, decimals_);
    }

    /// @notice Deploy a role-gated mintable ERC-20 with `admin` as admin+minter.
    function deployMintableERC20(string memory name_, string memory symbol_, address admin_)
        internal
        returns (FixtureMintableERC20)
    {
        return new FixtureMintableERC20(name_, symbol_, admin_);
    }

    /// @notice Deploy a mintable ERC-721.
    function deployERC721(string memory name_, string memory symbol_) internal returns (FixtureERC721) {
        return new FixtureERC721(name_, symbol_);
    }

    /// @notice Mint `amount` of `token` to `to` and have `to` max-approve `spender`.
    function fundAndApprove(FixtureERC20 token, address to, uint256 amount, address spender) internal {
        token.mint(to, amount);
        vm.prank(to);
        token.approve(spender, type(uint256).max);
    }

    // ---- Time-travel wrappers (clearer than raw cheatcodes at call sites) ----

    /// @notice Advance block.timestamp by `secs` seconds.
    function warpBy(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
    }

    /// @notice Set block.timestamp to an absolute value.
    function warpTo(uint256 ts) internal {
        vm.warp(ts);
    }

    /// @notice Advance block.number by `n` blocks.
    function rollBy(uint256 n) internal {
        vm.roll(block.number + n);
    }

    /// @notice Advance both time and blocks together (approx `secs` at 12s/block by default n).
    function skipTime(uint256 secs, uint256 blocks) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + blocks);
    }
}
