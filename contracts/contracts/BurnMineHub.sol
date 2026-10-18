// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {BurnMine, IMintable} from "./BurnMine.sol";

/// @title BurnMineHub — the "Burn Mine": a PLACE that mints + hosts many burn contracts
///
/// @notice Operator's framing: the Burn Mine is **not a single contract — it is a place to mint and host
///         burn contracts**, and burning mints **KULA AND other tokens**. So this hub is a factory +
///         registry: a curator deploys immutable {BurnMine} units (each burns ONE input → mints ONE
///         output token at a fixed ratio) under one roof, and can also register externally-deployed burn
///         contracts so the front-end "Burn Mine" page lists them all. Different hosted mines can mint
///         DIFFERENT outputs (KULA, PoL, an ecosystem token …) — the hub does not assume one token.
///
/// @dev The hub itself never mints. Each deployed/registered mine needs `MINTER_ROLE` on ITS OWN output
///      token — granted by that token's admin after {deployBurnMine} (the hub can't grant a role it
///      doesn't administer). Keep CURATOR_ROLE on a multisig/timelock: a hosted mine is mint authority on
///      its output, so listing one is a trust statement.
contract BurnMineHub is AccessControl {
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");

    struct Mine {
        address mine;     // the BurnMine (or external burn contract) address
        address input;    // token burned
        address output;   // token minted
        uint256 num;      // ratio: out = in * num / den
        uint256 den;
        bool active;      // hidden from the UI when false (does not affect the immutable mine itself)
        bool external_;   // true = registered (deployed elsewhere), false = deployed by this hub
        string label;     // human label for the "Burn Mine" page (e.g. "Burn PoL → KULA")
    }

    Mine[] public mines;
    mapping(address => bool) public isHosted;   // mine address → hosted here

    event BurnMineDeployed(uint256 indexed id, address indexed mine, address indexed output, address input, uint256 num, uint256 den, string label);
    event BurnMineRegistered(uint256 indexed id, address indexed mine, address indexed output, address input, uint256 num, uint256 den, string label);
    event MineActiveSet(uint256 indexed id, bool active);

    error AlreadyHosted(address mine);
    error BadId(uint256 id);

    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, admin);
    }

    /// @notice Deploy a NEW immutable BurnMine under the hub: burn `input` → mint `output` at num/den.
    /// @dev After this, the `output` token's admin must grant the returned mine `MINTER_ROLE`.
    function deployBurnMine(ERC20Burnable input, IMintable output, uint256 num, uint256 den, string calldata label)
        external
        onlyRole(CURATOR_ROLE)
        returns (BurnMine mine, uint256 id)
    {
        mine = new BurnMine(input, output, num, den);   // BurnMine validates non-zero + ratio>0
        id = _record(address(mine), address(input), address(output), num, den, false, label);
        emit BurnMineDeployed(id, address(mine), address(output), address(input), num, den, label);
    }

    /// @notice Host an EXISTING burn contract (deployed elsewhere) so the Burn Mine page lists it.
    function registerBurnMine(address mine, address input, address output, uint256 num, uint256 den, string calldata label)
        external
        onlyRole(CURATOR_ROLE)
        returns (uint256 id)
    {
        require(mine != address(0) && output != address(0), "zero addr");
        id = _record(mine, input, output, num, den, true, label);
        emit BurnMineRegistered(id, mine, output, input, num, den, label);
    }

    /// @notice Show/hide a hosted mine on the front-end (does NOT touch the immutable mine on-chain).
    function setActive(uint256 id, bool active) external onlyRole(CURATOR_ROLE) {
        if (id >= mines.length) revert BadId(id);
        mines[id].active = active;
        emit MineActiveSet(id, active);
    }

    function mineCount() external view returns (uint256) { return mines.length; }

    /// @notice All currently-active hosted mines (for the Burn Mine page).
    function activeMines() external view returns (Mine[] memory out) {
        uint256 n;
        for (uint256 i; i < mines.length; ++i) if (mines[i].active) ++n;
        out = new Mine[](n);
        uint256 j;
        for (uint256 i; i < mines.length; ++i) if (mines[i].active) out[j++] = mines[i];
    }

    function _record(address mine, address input, address output, uint256 num, uint256 den, bool ext, string calldata label)
        internal
        returns (uint256 id)
    {
        if (isHosted[mine]) revert AlreadyHosted(mine);
        isHosted[mine] = true;
        id = mines.length;
        mines.push(Mine({mine: mine, input: input, output: output, num: num, den: den, active: true, external_: ext, label: label}));
    }
}
