// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IKulaMint {
    function mint(address to, uint256 amount) external;
}
interface IBurnableToken {
    function burn(uint256 amount) external;
}

/// @title MultiBurnMine — burn MANY tokens/coins → mint KULA
///
/// @notice One burn-mine that accepts a whole REGISTRY of input tokens (PoL, VKBT, CURE, wrapped SWAP
///         coins, …), each at its own fixed ratio, and mints KULA out: `kulaOut = received * num / den`.
///         The operator's "the burn mine overall has many tokens and coins that go in." Unlike the
///         immutable single-input {BurnMine}, this is admin-curated (you add/disable input tokens and
///         set ratios) — so it carries access control, a pause, and a reentrancy guard.
///
/// @dev Trust/economics:
///        - This contract must hold `MINTER_ROLE` on KULA.
///        - Each input is BURNED (real supply sink): tokens exposing `burn(uint256)` are burned in
///          place; the rest are swept to `DEAD` (0x…dEaD) which is equivalent for supply purposes.
///        - **Fee-on-transfer safe:** we mint on the ACTUAL received amount (balance delta), not the
///          requested amount, so a FoT input can never mint more KULA than truly arrived.
///        - Admin (`DEFAULT_ADMIN_ROLE`) curates the registry; `PAUSER_ROLE` can freeze minting.
///          Set the admin to a multisig/timelock for mainnet (each added token is new KULA issuance).
contract MultiBurnMine is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IKulaMint public immutable kula;

    struct InputConfig {
        uint256 num;       // kulaOut = received * num / den
        uint256 den;
        bool burnable;     // token exposes burn(uint256) → burn in place; else sweep to DEAD
        bool enabled;
    }
    mapping(address => InputConfig) public inputs;     // input token => config
    mapping(address => uint256) public totalMinedFrom; // input token => KULA minted against it

    event InputSet(address indexed token, uint256 num, uint256 den, bool burnable, bool enabled);
    event Mined(address indexed who, address indexed token, uint256 amountIn, uint256 kulaOut);

    error NotEnabled(address token);
    error BadRatio();
    error ZeroAmount();
    error NothingReceived();

    constructor(IKulaMint kula_, address admin) {
        require(address(kula_) != address(0) && admin != address(0), "zero addr");
        kula = kula_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ── admin: curate the input registry ────────────────────────────────────────────────────────
    /// @notice Register / update / disable an input token. ratio kulaOut = received * num / den.
    function setInput(address token, uint256 num, uint256 den, bool burnable, bool enabled)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(0), "token=0");
        if (enabled && (num == 0 || den == 0)) revert BadRatio();
        inputs[token] = InputConfig({num: num, den: den, burnable: burnable, enabled: enabled});
        emit InputSet(token, num, den, burnable, enabled);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ── burn an input → mint KULA ─────────────────────────────────────────────────────────────────
    /// @notice Burn `amount` of a registered `token`, mint KULA to the caller at the token's ratio.
    ///         Mints on the ACTUAL received amount (FoT-safe). The input is burned (or swept to DEAD).
    /// @return kulaOut KULA minted to the caller.
    function mine(address token, uint256 amount) external nonReentrant whenNotPaused returns (uint256 kulaOut) {
        if (amount == 0) revert ZeroAmount();
        InputConfig memory c = inputs[token];
        if (!c.enabled) revert NotEnabled(token);

        // pull in, measuring the real delta (fee-on-transfer safe).
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();

        // sink it: burn in place if the token supports it, else send to DEAD.
        if (c.burnable) {
            IBurnableToken(token).burn(received);
        } else {
            IERC20(token).safeTransfer(DEAD, received);
        }

        kulaOut = (received * c.num) / c.den;
        require(kulaOut > 0, "out=0");           // dust guard: ratio too small for this amount
        totalMinedFrom[token] += kulaOut;
        kula.mint(msg.sender, kulaOut);
        emit Mined(msg.sender, token, received, kulaOut);
    }
}
