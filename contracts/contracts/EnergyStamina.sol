// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal staked-balance source: anything exposing a `balanceOf(address)` (an ERC-20,
///         a staking vault, a vote-escrow contract) can drive the optional stake boost.
interface IStakeSource {
    function balanceOf(address account) external view returns (uint256);
}

/// @title EnergyStamina — per-player regenerating action budget, scoped per game
/// @notice Each registered game gets its own stamina meter: a `maxEnergy` cap and a
///         `regenPerBlock` refill rate. Players spend energy to take in-game actions; the
///         meter regenerates lazily on every touch (no keeper). Only the game contract a
///         meter belongs to may `spend` on behalf of its players, so meters are isolated:
///         draining one game's stamina cannot touch another's.
/// @dev    Mirrors the EnergyGasAccountant lazy-regen pattern, but the budget here is a flat
///         per-game allowance (not stake-proportional) — except for an OPTIONAL stake-boost
///         multiplier sourced from an external staked-balance contract. Regen is measured in
///         BLOCKS (deterministic ordering / clock for games) rather than seconds.
contract EnergyStamina is AccessControl {
    /// @notice Role allowed to register / configure games.
    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");
    /// @notice Role allowed to administer the registry (also holds GAME_ROLE management).
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev Boost multiplier is scaled by BOOST_ONE (1e18 == 1.0x, no boost).
    uint256 public constant BOOST_ONE = 1e18;

    struct Game {
        bool registered;
        uint256 maxEnergy;       // base cap, before any stake boost
        uint256 regenPerBlock;   // base refill per block, before any stake boost
        IStakeSource stakeSource; // optional; address(0) disables the boost
        uint256 boostPerStake;   // extra multiplier per staked unit, scaled by BOOST_ONE
        uint256 maxBoost;        // multiplier cap, scaled by BOOST_ONE (>= BOOST_ONE)
    }

    struct Meter {
        uint256 energy;
        uint64 lastBlock;
        bool seeded; // distinguishes "fresh player" (start full) from "drained to 0"
    }

    /// @dev game contract address => config.
    mapping(address => Game) public games;
    /// @dev game => player => meter.
    mapping(address => mapping(address => Meter)) public meters;

    event GameRegistered(address indexed game, uint256 maxEnergy, uint256 regenPerBlock);
    event GameUpdated(address indexed game, uint256 maxEnergy, uint256 regenPerBlock);
    event GameRemoved(address indexed game);
    event StakeBoostSet(
        address indexed game,
        address indexed stakeSource,
        uint256 boostPerStake,
        uint256 maxBoost
    );
    event Spent(address indexed game, address indexed player, uint256 amount, uint256 remaining);

    error ZeroAddress();
    error BadParams();
    error AlreadyRegistered(address game);
    error NotRegistered(address game);
    error InsufficientEnergy(uint256 available, uint256 requested);

    /// @param admin Address granted DEFAULT_ADMIN_ROLE + ADMIN_ROLE, and made the admin of GAME_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        // ADMIN_ROLE governs who can hold GAME_ROLE; the deployer-admin also gets it so it
        // can register games out of the box.
        _setRoleAdmin(GAME_ROLE, ADMIN_ROLE);
        _grantRole(GAME_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                          Game registration                            //
    // --------------------------------------------------------------------- //

    /// @notice Register a new game meter. Authorization to spend a meter is the registration
    ///         itself: only the registered `game` address can later call {spend} on its meter.
    function registerGame(address game, uint256 maxEnergy_, uint256 regenPerBlock_)
        external
        onlyRole(GAME_ROLE)
    {
        if (game == address(0)) revert ZeroAddress();
        if (maxEnergy_ == 0) revert BadParams();
        if (games[game].registered) revert AlreadyRegistered(game);

        games[game] = Game({
            registered: true,
            maxEnergy: maxEnergy_,
            regenPerBlock: regenPerBlock_,
            stakeSource: IStakeSource(address(0)),
            boostPerStake: 0,
            maxBoost: BOOST_ONE
        });
        emit GameRegistered(game, maxEnergy_, regenPerBlock_);
    }

    /// @notice Update an existing game's base cap / regen rate.
    function updateGame(address game, uint256 maxEnergy_, uint256 regenPerBlock_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (maxEnergy_ == 0) revert BadParams();
        Game storage g = games[game];
        if (!g.registered) revert NotRegistered(game);
        g.maxEnergy = maxEnergy_;
        g.regenPerBlock = regenPerBlock_;
        emit GameUpdated(game, maxEnergy_, regenPerBlock_);
    }

    /// @notice Configure (or disable) the optional stake-boost for a game.
    /// @param stakeSource   contract exposing `balanceOf(player)`; address(0) disables the boost.
    /// @param boostPerStake extra multiplier added per staked unit (scaled by BOOST_ONE).
    /// @param maxBoost      multiplier ceiling (scaled by BOOST_ONE); must be >= BOOST_ONE.
    function setStakeBoost(
        address game,
        IStakeSource stakeSource,
        uint256 boostPerStake,
        uint256 maxBoost
    ) external onlyRole(ADMIN_ROLE) {
        Game storage g = games[game];
        if (!g.registered) revert NotRegistered(game);
        if (maxBoost < BOOST_ONE) revert BadParams();
        g.stakeSource = stakeSource;
        g.boostPerStake = boostPerStake;
        g.maxBoost = maxBoost;
        emit StakeBoostSet(game, address(stakeSource), boostPerStake, maxBoost);
    }

    /// @notice Remove a game from the registry.
    function removeGame(address game) external onlyRole(ADMIN_ROLE) {
        if (!games[game].registered) revert NotRegistered(game);
        delete games[game];
        emit GameRemoved(game);
    }

    // --------------------------------------------------------------------- //
    //                                Views                                  //
    // --------------------------------------------------------------------- //

    /// @notice Stake-boost multiplier for `player` in `game` (scaled by BOOST_ONE; BOOST_ONE == 1x).
    function boostOf(address game, address player) public view returns (uint256) {
        Game storage g = games[game];
        if (address(g.stakeSource) == address(0) || g.boostPerStake == 0) return BOOST_ONE;
        uint256 staked = g.stakeSource.balanceOf(player);
        uint256 mult = BOOST_ONE + staked * g.boostPerStake;
        return mult > g.maxBoost ? g.maxBoost : mult;
    }

    /// @notice Effective (boosted) energy cap for `player` in `game`.
    function maxEnergyOf(address game, address player) public view returns (uint256) {
        Game storage g = games[game];
        return (g.maxEnergy * boostOf(game, player)) / BOOST_ONE;
    }

    /// @notice Effective (boosted) refill per block for `player` in `game`.
    function regenPerBlockOf(address game, address player) public view returns (uint256) {
        Game storage g = games[game];
        return (g.regenPerBlock * boostOf(game, player)) / BOOST_ONE;
    }

    /// @notice Current energy of `player` in `game` (view — accounts for lazy regen since last touch).
    /// @dev A never-seen player starts at the full (boosted) cap.
    function energyOf(address game, address player) public view returns (uint256) {
        Game storage g = games[game];
        if (!g.registered) return 0;

        uint256 cap = maxEnergyOf(game, player);
        Meter storage m = meters[game][player];
        if (!m.seeded) return cap;

        uint256 blocksPassed = block.number - m.lastBlock;
        uint256 regen = blocksPassed * regenPerBlockOf(game, player);
        uint256 e = m.energy + regen;
        return e > cap ? cap : e;
    }

    // --------------------------------------------------------------------- //
    //                                Spend                                  //
    // --------------------------------------------------------------------- //

    /// @notice Spend `amount` of `player`'s energy. Callable ONLY by the registered game itself.
    /// @dev Regenerates lazily, checks budget, then debits — settling the meter to the current block.
    function spend(address player, uint256 amount) external {
        Game storage g = games[msg.sender];
        if (!g.registered) revert NotRegistered(msg.sender);
        // The meter belongs to msg.sender's game; only that game may spend it.
        // (Registration + this check together enforce per-game isolation.)
        if (player == address(0)) revert ZeroAddress();

        uint256 available = energyOf(msg.sender, player);
        if (available < amount) revert InsufficientEnergy(available, amount);

        uint256 remaining = available - amount;
        Meter storage m = meters[msg.sender][player];
        m.energy = remaining;
        m.lastBlock = uint64(block.number);
        m.seeded = true;

        emit Spent(msg.sender, player, amount, remaining);
    }
}
