// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Burnable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SeasonalFarm
/// @notice A block-paced farming game on a single ERC-1155 collection. A player plants a
///         seed into a plot they own, optionally adding a water consumable to shorten the
///         growth time, waits a fixed number of blocks for the crop to mature, then
///         harvests a yield item. Seeds and water are burned on plant (supply sinks); the
///         harvest mints fresh yield tokens. A per-season yield modifier (set by an
///         oracle/admin role) scales the harvest amount.
/// @dev    The collection is partitioned into id ranges so plots, seeds, water, and yields
///         never collide (see the *_BASE constants). The farm mints/burns its own tokens
///         directly (it IS the ERC-1155), so no cross-contract role grant is needed.
contract SeasonalFarm is ERC1155, ERC1155Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant MODIFIER_ROLE = keccak256("MODIFIER_ROLE");

    // --------------------------------------------------------------------- //
    //  Id-range layout (16M ids per class; class = id / RANGE)              //
    // --------------------------------------------------------------------- //
    uint256 public constant RANGE = 0x1000000; // 16,777,216 ids per class
    uint256 public constant PLOT_BASE = 0 * RANGE; //        0 .. 16M-1   : plot tokens
    uint256 public constant SEED_BASE = 1 * RANGE; //       16M .. 32M-1  : seed tokens
    uint256 public constant WATER_BASE = 2 * RANGE; //      32M .. 48M-1  : water consumables
    uint256 public constant YIELD_BASE = 3 * RANGE; //      48M .. 64M-1  : harvest yields

    /// @notice Fixed-point denominator for the season yield modifier (10000 = 1.0x).
    uint256 public constant MODIFIER_DENOMINATOR = 10_000;

    /// @notice Base growth duration, in blocks, before a crop matures.
    uint256 public immutable growthBlocks;

    /// @notice Blocks of growth removed by adding one unit of water at plant time.
    uint256 public immutable waterBoostBlocks;

    /// @notice Base yield amount per harvest (before the season modifier is applied).
    uint256 public immutable baseYield;

    /// @notice Current season index.
    uint256 public season;

    /// @notice Yield modifier for a given season, in MODIFIER_DENOMINATOR units
    ///         (10000 = 1.0x). Season 0 defaults to 1.0x.
    mapping(uint256 => uint256) public seasonModifier;

    struct Planting {
        uint256 seedId; // seed-range id that was planted
        uint256 readyBlock; // block at/after which harvest is allowed
        uint256 season; // season the crop was planted in (locks its modifier source)
        bool active; // a crop currently occupies this plot
    }

    /// @notice plotId => current planting (one crop per plot at a time).
    mapping(uint256 => Planting) public plantings;

    event Planted(
        address indexed farmer,
        uint256 indexed plotId,
        uint256 indexed seedId,
        uint256 waterUsed,
        uint256 readyBlock
    );
    event Harvested(
        address indexed farmer,
        uint256 indexed plotId,
        uint256 yieldId,
        uint256 amount
    );
    event SeasonAdvanced(uint256 indexed season, uint256 modifierBps);

    error NotPlotOwner(uint256 plotId);
    error NotAPlot(uint256 plotId);
    error NotASeed(uint256 seedId);
    error PlotOccupied(uint256 plotId);
    error PlotEmpty(uint256 plotId);
    error NotMature(uint256 plotId);
    error ZeroModifier();

    /// @param baseURI ERC-1155 metadata URI template.
    /// @param growthBlocks_ Base blocks until a crop matures.
    /// @param waterBoostBlocks_ Blocks removed per unit of water at plant time.
    /// @param baseYield_ Base harvest amount before the season modifier.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE, MINTER_ROLE and MODIFIER_ROLE.
    constructor(
        string memory baseURI,
        uint256 growthBlocks_,
        uint256 waterBoostBlocks_,
        uint256 baseYield_,
        address admin
    ) ERC1155(baseURI) {
        growthBlocks = growthBlocks_;
        waterBoostBlocks = waterBoostBlocks_;
        baseYield = baseYield_;

        // Season 0 starts at 1.0x.
        seasonModifier[0] = MODIFIER_DENOMINATOR;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(MODIFIER_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //  Id-range helpers                                                     //
    // --------------------------------------------------------------------- //

    function isPlot(uint256 id) public pure returns (bool) {
        return id >= PLOT_BASE && id < SEED_BASE;
    }

    function isSeed(uint256 id) public pure returns (bool) {
        return id >= SEED_BASE && id < WATER_BASE;
    }

    function isWater(uint256 id) public pure returns (bool) {
        return id >= WATER_BASE && id < YIELD_BASE;
    }

    function isYield(uint256 id) public pure returns (bool) {
        return id >= YIELD_BASE && id < YIELD_BASE + RANGE;
    }

    /// @dev Maps a seed id to its corresponding yield id (same offset within the range),
    ///      so each seed variety produces a deterministic, distinct crop.
    function yieldIdForSeed(uint256 seedId) public pure returns (uint256) {
        return YIELD_BASE + (seedId - SEED_BASE);
    }

    // --------------------------------------------------------------------- //
    //  Token issuance (role-gated) — plots/seeds/water are minted to players //
    // --------------------------------------------------------------------- //

    /// @notice Mint farm tokens (plots, seeds, water) to a player. Yields are produced
    ///         only via `harvest`, so MINTER_ROLE cannot pre-mint yield ids.
    function mint(address to, uint256 id, uint256 amount, bytes calldata data)
        external
        onlyRole(MINTER_ROLE)
    {
        require(!isYield(id), "yield via harvest only");
        _mint(to, id, amount, data);
    }

    // --------------------------------------------------------------------- //
    //  Season control                                                       //
    // --------------------------------------------------------------------- //

    /// @notice Advance to the next season and set its yield modifier (in bps; 10000 = 1.0x).
    /// @dev Only MODIFIER_ROLE (admin/oracle). New plantings use the new season's modifier;
    ///      crops planted in an earlier season harvest at the modifier of their plant season.
    function advanceSeason(uint256 modifierBps) external onlyRole(MODIFIER_ROLE) {
        if (modifierBps == 0) revert ZeroModifier();
        season += 1;
        seasonModifier[season] = modifierBps;
        emit SeasonAdvanced(season, modifierBps);
    }

    /// @notice Set the yield modifier for the current season (in bps; 10000 = 1.0x).
    function setSeasonModifier(uint256 modifierBps) external onlyRole(MODIFIER_ROLE) {
        if (modifierBps == 0) revert ZeroModifier();
        seasonModifier[season] = modifierBps;
        emit SeasonAdvanced(season, modifierBps);
    }

    // --------------------------------------------------------------------- //
    //  Plant / harvest                                                      //
    // --------------------------------------------------------------------- //

    /// @notice Plant a seed into a plot the caller owns, optionally adding water to shorten
    ///         growth. Burns one seed and `waterUnits` water from the caller (supply sink),
    ///         and starts the growth clock. A plot cannot be double-planted.
    /// @param seedId A seed-range id.
    /// @param plotId A plot-range id the caller holds.
    /// @param waterUnits Units of the matching water id to consume (0 for none).
    function plant(uint256 seedId, uint256 plotId, uint256 waterUnits) external {
        if (!isPlot(plotId)) revert NotAPlot(plotId);
        if (!isSeed(seedId)) revert NotASeed(seedId);
        if (balanceOf(msg.sender, plotId) == 0) revert NotPlotOwner(plotId);
        if (plantings[plotId].active) revert PlotOccupied(plotId);

        // Burn the seed (sink). Reverts if the caller lacks one.
        _burn(msg.sender, seedId, 1);

        // Optional water: burn matching water id and shorten growth.
        uint256 growth = growthBlocks;
        if (waterUnits > 0) {
            uint256 waterId = WATER_BASE + (seedId - SEED_BASE);
            _burn(msg.sender, waterId, waterUnits);
            uint256 reduction = waterUnits * waterBoostBlocks;
            // Never below a 1-block minimum so harvest is still gated by a future block.
            growth = reduction >= growth ? 1 : growth - reduction;
        }

        uint256 readyBlock = block.number + growth;
        plantings[plotId] = Planting({
            seedId: seedId,
            readyBlock: readyBlock,
            season: season,
            active: true
        });

        emit Planted(msg.sender, plotId, seedId, waterUnits, readyBlock);
    }

    /// @notice Harvest a matured crop from a plot the caller owns. Mints the yield (scaled
    ///         by the modifier of the season the crop was planted in) and frees the plot.
    function harvest(uint256 plotId) external returns (uint256 yieldId, uint256 amount) {
        if (balanceOf(msg.sender, plotId) == 0) revert NotPlotOwner(plotId);

        Planting memory p = plantings[plotId];
        if (!p.active) revert PlotEmpty(plotId);
        if (block.number < p.readyBlock) revert NotMature(plotId);

        // Effects: free the plot before minting.
        delete plantings[plotId];

        yieldId = yieldIdForSeed(p.seedId);
        uint256 mod = seasonModifier[p.season];
        amount = (baseYield * mod) / MODIFIER_DENOMINATOR;

        _mint(msg.sender, yieldId, amount, "");
        emit Harvested(msg.sender, plotId, yieldId, amount);
    }

    /// @notice Whether a plot's crop is mature and ready to harvest.
    function isReady(uint256 plotId) external view returns (bool) {
        Planting memory p = plantings[plotId];
        return p.active && block.number >= p.readyBlock;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
