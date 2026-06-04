// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMintable} from "../../contracts/BurnMine.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title FixtureERC20 — test-only mintable + burnable ERC-20.
/// @notice Mirrors contracts/mocks/MockERC20.sol so forge tests don't depend on Hardhat mocks.
///         Open mint/burn — for fixtures only, never deploy to a real network.
contract FixtureERC20 is ERC20, ERC20Burnable {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title FixtureMintableERC20 — role-gated mintable ERC-20 (mirrors PoLToken).
/// @notice Use as a burn-mine OUTPUT token: grant MINTER_ROLE to the consumer (e.g. a BurnMine).
contract FixtureMintableERC20 is ERC20, ERC20Burnable, AccessControl, IMintable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(string memory name_, string memory symbol_, address admin) ERC20(name_, symbol_) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mint(address to, uint256 amount) external override onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}

/// @title FixtureERC721 — test-only mintable ERC-721 with sequential ids.
contract FixtureERC721 is ERC721 {
    uint256 public nextId;

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    /// @notice Mint the next sequential token id to `to`; returns the minted id.
    function mint(address to) external returns (uint256 id) {
        id = nextId++;
        _mint(to, id);
    }

    /// @notice Mint a specific id (for tests that need a fixed token id).
    function mintId(address to, uint256 id) external {
        _mint(to, id);
    }
}
