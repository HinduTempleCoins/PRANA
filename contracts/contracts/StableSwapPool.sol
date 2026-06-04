// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StableSwapPool — two-token Curve-style StableSwap invariant pool
/// @notice A constant-function market maker for two tokens that are *expected* to trade near a
///         1:1 peg (e.g. a coin and its pegged/wrapped representation, or two pegged variants).
///         Unlike the constant-SUM `PeggedSwapPool` (rigid 1:1, no slippage curve) and unlike a
///         constant-PRODUCT x*y=k pair (heavy slippage even near peg), StableSwap blends both:
///         near the peg it behaves almost like constant-sum (tiny slippage, dy/dx ≈ 1), but as the
///         pool becomes imbalanced it smoothly approaches constant-product so it never runs a
///         reserve fully dry. The "amplification coefficient" A controls how flat the curve is
///         around the peg (higher A = flatter = more peg-like).
///
///         The StableSwap invariant for n=2 coins with balances x_0, x_1 and amplification A:
///
///             A * n^n * S + D = A * D * n^n + D^(n+1) / (n^n * P)
///
///         where S = sum(x_i), P = prod(x_i), n = 2. D (the invariant) is solved by Newton
///         iteration; swap outputs are found by solving the same invariant for the new y given a
///         fixed D and the other balance.
///
/// @dev DECIMALS: both tokens are assumed to be 18-decimal. Precision/rate multipliers for
///      mismatched-decimal tokens are intentionally OUT OF SCOPE — wiring this to a non-18-decimal
///      token would silently misprice. Validate decimals off-chain before deploying a pool.
///
/// @dev LP token: the pool *is* its own ERC-20 (this contract inherits ERC20); LP shares are minted
///      to liquidity providers and track D-denominated ownership of the pool.
contract StableSwapPool is ERC20, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- roles -------------------------------------------------------------
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // --- constants ---------------------------------------------------------
    uint256 public constant N_COINS = 2;
    uint256 public constant A_PRECISION = 100; // A is stored * A_PRECISION (Curve convention)
    uint256 public constant BPS = 10_000;
    /// @dev Fee is capped at 1% (100 bps) — a stable pool charging more would be pathological.
    uint256 public constant MAX_FEE_BPS = 100;
    /// @dev A bounds (in raw, un-scaled units). Curve uses 1..1e6; we mirror that.
    uint256 public constant MIN_A = 1;
    uint256 public constant MAX_A = 1_000_000;
    /// @dev A may not ramp faster than 10x per ramp, and ramps take >= MIN_RAMP_TIME.
    uint256 public constant MAX_A_CHANGE = 10;
    uint256 public constant MIN_RAMP_TIME = 1 days;
    /// @dev Newton iteration bound — Curve uses 255; convergence for n=2 is typically < 10 rounds.
    uint256 internal constant MAX_ITER = 255;

    // --- tokens ------------------------------------------------------------
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    // --- state -------------------------------------------------------------
    uint256 public reserve0;
    uint256 public reserve1;

    /// @dev Imbalance fee in bps, applied to the per-coin imbalance on non-proportional
    ///      add/remove (Curve's dynamic fee, simplified to a flat per-coin bps).
    uint256 public feeBps;

    // A ramp state (all A values stored * A_PRECISION)
    uint256 public initialA;
    uint256 public futureA;
    uint256 public initialATime;
    uint256 public futureATime;

    // --- events ------------------------------------------------------------
    event AddLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 lpMinted, uint256 invariant);
    event RemoveLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 lpBurned);
    event RemoveLiquidityOneCoin(address indexed provider, uint8 coin, uint256 amountOut, uint256 lpBurned);
    event TokenExchange(address indexed buyer, uint8 soldId, uint256 amountSold, uint8 boughtId, uint256 amountBought);
    event RampA(uint256 initialA, uint256 futureA, uint256 initialTime, uint256 futureTime);
    event StopRampA(uint256 currentA, uint256 atTime);
    event FeeUpdated(uint256 feeBps);

    // --- errors ------------------------------------------------------------
    error ZeroAddress();
    error IdenticalTokens();
    error FeeTooHigh();
    error InvalidCoin();
    error ZeroAmount();
    error InsufficientOutput(); // minDy / slippage protection
    error DDidNotConverge();
    error YDidNotConverge();
    error RampTooSoon();
    error RampTooFast();
    error InvalidA();
    error InsufficientLiquidity();
    error ImbalancedFirstDeposit();

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 token0_,
        IERC20 token1_,
        uint256 a_,
        uint256 feeBps_,
        address admin_
    ) ERC20(name_, symbol_) {
        if (address(token0_) == address(0) || address(token1_) == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        if (address(token0_) == address(token1_)) revert IdenticalTokens();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (a_ < MIN_A || a_ > MAX_A) revert InvalidA();

        token0 = token0_;
        token1 = token1_;
        feeBps = feeBps_;

        uint256 scaledA = a_ * A_PRECISION;
        initialA = scaledA;
        futureA = scaledA;
        initialATime = block.timestamp;
        futureATime = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    // =======================================================================
    //                          AMPLIFICATION (A)
    // =======================================================================

    /// @notice The current amplification coefficient * A_PRECISION, linearly interpolated if a
    ///         ramp is in progress.
    function getA() public view returns (uint256) {
        uint256 t1 = futureATime;
        uint256 a1 = futureA;
        if (block.timestamp < t1) {
            uint256 a0 = initialA;
            uint256 t0 = initialATime;
            // linear interpolation between (t0,a0) and (t1,a1)
            if (a1 > a0) {
                return a0 + ((a1 - a0) * (block.timestamp - t0)) / (t1 - t0);
            } else {
                return a0 - ((a0 - a1) * (block.timestamp - t0)) / (t1 - t0);
            }
        }
        return a1;
    }

    /// @notice The current amplification coefficient in raw (un-scaled) units, for display.
    function A() external view returns (uint256) {
        return getA() / A_PRECISION;
    }

    /// @notice Begin a linear ramp of A from its current value to `futureA_` (raw units) by
    ///         `futureTime_`. Mirrors Curve: gated by MIN_RAMP_TIME and a max 10x change.
    function rampA(uint256 futureARaw, uint256 futureTime_) external onlyRole(ADMIN_ROLE) {
        if (block.timestamp < initialATime + MIN_RAMP_TIME) revert RampTooSoon();
        if (futureTime_ < block.timestamp + MIN_RAMP_TIME) revert RampTooSoon();
        if (futureARaw < MIN_A || futureARaw > MAX_A) revert InvalidA();

        uint256 a0 = getA();
        uint256 a1 = futureARaw * A_PRECISION;
        // Constrain the magnitude of change to <= MAX_A_CHANGE x (in either direction).
        if (a1 > a0) {
            if (a1 > a0 * MAX_A_CHANGE) revert RampTooFast();
        } else {
            if (a1 * MAX_A_CHANGE < a0) revert RampTooFast();
        }

        initialA = a0;
        futureA = a1;
        initialATime = block.timestamp;
        futureATime = futureTime_;

        emit RampA(a0, a1, block.timestamp, futureTime_);
    }

    /// @notice Freeze A at its current interpolated value, aborting any in-flight ramp.
    function stopRampA() external onlyRole(ADMIN_ROLE) {
        uint256 current = getA();
        initialA = current;
        futureA = current;
        initialATime = block.timestamp;
        futureATime = block.timestamp;
        emit StopRampA(current, block.timestamp);
    }

    /// @notice Set the imbalance fee (bps), capped at MAX_FEE_BPS.
    function setFee(uint256 feeBps_) external onlyRole(ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    // =======================================================================
    //                         INVARIANT MATH (D, y)
    // =======================================================================

    /// @notice Compute the StableSwap invariant D for balances (x0, x1) at amplification `amp`
    ///         (amp is A * A_PRECISION). Newton's method, bounded at MAX_ITER.
    /// @dev For n=2: Ann = amp * n. D_P telescopes as D^(n+1)/(n^n * prod(x)).
    function _getD(uint256 x0, uint256 x1, uint256 amp) internal pure returns (uint256) {
        uint256 s = x0 + x1;
        if (s == 0) return 0;

        uint256 d = s;
        uint256 ann = amp * N_COINS; // A * A_PRECISION * n

        for (uint256 i = 0; i < MAX_ITER; ++i) {
            // D_P = D^(n+1) / (n^n * prod(x)) ; for n=2: D_P = D^3 / (4 * x0 * x1)
            uint256 dP = d;
            dP = (dP * d) / (x0 * N_COINS);
            dP = (dP * d) / (x1 * N_COINS);

            uint256 dPrev = d;
            // d = (Ann/Ap * S + D_P * n) * D / ((Ann/Ap - 1) * D + (n+1) * D_P)
            uint256 numerator = ((ann * s) / A_PRECISION + dP * N_COINS) * d;
            uint256 denominator =
                ((ann - A_PRECISION) * d) / A_PRECISION + (N_COINS + 1) * dP;
            d = numerator / denominator;

            if (_absDiff(d, dPrev) <= 1) return d;
        }
        revert DDidNotConverge();
    }

    /// @notice Given new balance `x` of coin `i` and invariant `d`, solve for the balance `y` of
    ///         the other coin via Newton's method (bounded at MAX_ITER).
    /// @dev y^2 + y*(b - D) = c ; solved as y = (y^2 + c) / (2y + b - D).
    function _getY(uint256 x, uint256 d, uint256 amp) internal pure returns (uint256) {
        uint256 ann = amp * N_COINS;

        // c = D^(n+1) / (n^n * x * Ann) ; for n=2: c = D^3 / (4 * x * Ann)  (then * A_PRECISION)
        uint256 c = d;
        c = (c * d) / (x * N_COINS);
        c = (c * d * A_PRECISION) / (ann * N_COINS);

        // b = x + D * A_PRECISION / Ann
        uint256 b = x + (d * A_PRECISION) / ann;

        uint256 y = d;
        for (uint256 i = 0; i < MAX_ITER; ++i) {
            uint256 yPrev = y;
            // y = (y^2 + c) / (2y + b - D)
            y = (y * y + c) / (2 * y + b - d);
            if (_absDiff(y, yPrev) <= 1) return y;
        }
        revert YDidNotConverge();
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    // =======================================================================
    //                              VIEWS
    // =======================================================================

    /// @notice The current pool invariant D.
    function getVirtualPrice() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        uint256 d = _getD(reserve0, reserve1, getA());
        return (d * 1e18) / supply;
    }

    /// @notice The invariant D over the current reserves.
    function getD() external view returns (uint256) {
        return _getD(reserve0, reserve1, getA());
    }

    /// @notice Quote: amount of coin `j` received for `dx` of coin `i`, fee included.
    function getDy(uint8 i, uint8 j, uint256 dx) public view returns (uint256 dy) {
        if (i == j || i >= N_COINS || j >= N_COINS) revert InvalidCoin();
        (uint256 xi, uint256 xj) = i == 0 ? (reserve0, reserve1) : (reserve1, reserve0);
        if (xi == 0 || xj == 0) revert InsufficientLiquidity();

        uint256 amp = getA();
        uint256 d = _getD(reserve0, reserve1, amp);

        uint256 newXi = xi + dx;
        uint256 newXj = _getY(newXi, d, amp);
        // -1 to round in favor of the pool (Curve convention)
        uint256 gross = xj - newXj - 1;
        uint256 fee = (gross * feeBps) / BPS;
        dy = gross - fee;
    }

    // =======================================================================
    //                              EXCHANGE
    // =======================================================================

    /// @notice Swap `dx` of coin `i` for at least `minDy` of coin `j`.
    function exchange(uint8 i, uint8 j, uint256 dx, uint256 minDy)
        external
        nonReentrant
        returns (uint256 dy)
    {
        if (i == j || i >= N_COINS || j >= N_COINS) revert InvalidCoin();
        if (dx == 0) revert ZeroAmount();

        (uint256 xi, uint256 xj) = i == 0 ? (reserve0, reserve1) : (reserve1, reserve0);
        if (xi == 0 || xj == 0) revert InsufficientLiquidity();

        // Scoped block keeps the Newton intermediates off this frame (16-slot stack limit).
        {
            uint256 amp = getA();
            uint256 d = _getD(reserve0, reserve1, amp);
            uint256 newXj = _getY(xi + dx, d, amp);
            uint256 gross = xj - newXj - 1;
            dy = gross - (gross * feeBps) / BPS;
        }
        if (dy < minDy) revert InsufficientOutput();

        // Commit reserves. Fee stays in the pool (accrues to LPs) — so xj decreases only by `dy`.
        if (i == 0) {
            reserve0 = xi + dx;
            reserve1 = xj - dy;
        } else {
            reserve1 = xi + dx;
            reserve0 = xj - dy;
        }

        (i == 0 ? token0 : token1).safeTransferFrom(msg.sender, address(this), dx);
        (j == 0 ? token0 : token1).safeTransfer(msg.sender, dy);

        emit TokenExchange(msg.sender, i, dx, j, dy);
    }

    // =======================================================================
    //                            LIQUIDITY
    // =======================================================================

    /// @notice Add liquidity with arbitrary amounts. The first deposit must seed both coins; an
    ///         imbalanced subsequent deposit pays an imbalance fee on the deviation from the ideal
    ///         proportional split. Mints LP proportional to the increase in D.
    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minLp)
        external
        nonReentrant
        returns (uint256 minted)
    {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();

        uint256 amp = getA();
        uint256 supply = totalSupply();

        uint256 oldR0 = reserve0;
        uint256 oldR1 = reserve1;
        uint256 d0 = supply == 0 ? 0 : _getD(oldR0, oldR1, amp);

        uint256 newR0 = oldR0 + amount0;
        uint256 newR1 = oldR1 + amount1;

        if (supply == 0) {
            // First deposit: require both sides so D is well-defined; no imbalance fee.
            if (amount0 == 0 || amount1 == 0) revert ImbalancedFirstDeposit();
            uint256 dFirst = _getD(newR0, newR1, amp);
            minted = dFirst;
            reserve0 = newR0;
            reserve1 = newR1;
            // pull tokens
            token0.safeTransferFrom(msg.sender, address(this), amount0);
            token1.safeTransferFrom(msg.sender, address(this), amount1);
            if (minted < minLp) revert InsufficientOutput();
            _mint(msg.sender, minted);
            emit AddLiquidity(msg.sender, amount0, amount1, minted, dFirst);
            return minted;
        }

        // Subsequent deposit: charge an imbalance fee on each coin's deviation from the ideal
        // (proportional) balance implied by D1, then recompute D on the fee-adjusted balances.
        // (helper keeps the adj/d2 intermediates off this frame — 16-slot stack limit)
        uint256 d1;
        (minted, d1) = _lpForDeposit(oldR0, oldR1, newR0, newR1, d0, amp, supply);
        if (minted == 0) revert ZeroAmount();
        if (minted < minLp) revert InsufficientOutput();

        // Real reserves get the *full* deposited amounts; the imbalance fee simply reduces the LP
        // credited (the fee value stays in the pool for existing LPs).
        reserve0 = newR0;
        reserve1 = newR1;

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        _mint(msg.sender, minted);
        emit AddLiquidity(msg.sender, amount0, amount1, minted, d1);
    }

    /// @dev LP minted for a subsequent (possibly imbalanced) deposit: D1 on raw new balances,
    ///      imbalance fee applied, D2 on fee-adjusted balances, minted ∝ (D2 - D0)/D0.
    function _lpForDeposit(
        uint256 oldR0,
        uint256 oldR1,
        uint256 newR0,
        uint256 newR1,
        uint256 d0,
        uint256 amp,
        uint256 supply
    ) internal view returns (uint256 minted, uint256 d1) {
        d1 = _getD(newR0, newR1, amp);
        (uint256 adjR0, uint256 adjR1) = _applyImbalanceFee(oldR0, oldR1, newR0, newR1, d0, d1);
        uint256 d2 = _getD(adjR0, adjR1, amp);
        minted = (supply * (d2 - d0)) / d0;
    }

    /// @dev Compute fee-adjusted balances used to value an imbalanced deposit. For each coin, the
    ///      "ideal" post-deposit balance is oldBalance * d1 / d0; the deviation from ideal is
    ///      charged `feeBps`. Returns balances reduced by that fee (used only for LP valuation).
    function _applyImbalanceFee(
        uint256 oldR0,
        uint256 oldR1,
        uint256 newR0,
        uint256 newR1,
        uint256 d0,
        uint256 d1
    ) internal view returns (uint256 adjR0, uint256 adjR1) {
        uint256 ideal0 = (oldR0 * d1) / d0;
        uint256 ideal1 = (oldR1 * d1) / d0;
        uint256 fee0 = (_absDiff(ideal0, newR0) * feeBps) / BPS;
        uint256 fee1 = (_absDiff(ideal1, newR1) * feeBps) / BPS;
        adjR0 = newR0 - fee0;
        adjR1 = newR1 - fee1;
    }

    /// @notice Burn `lpAmount` LP and receive a proportional cut of both reserves (no fee).
    function removeLiquidity(uint256 lpAmount, uint256 minAmount0, uint256 minAmount1)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (lpAmount == 0) revert ZeroAmount();
        uint256 supply = totalSupply();

        amount0 = (reserve0 * lpAmount) / supply;
        amount1 = (reserve1 * lpAmount) / supply;
        if (amount0 < minAmount0 || amount1 < minAmount1) revert InsufficientOutput();

        reserve0 -= amount0;
        reserve1 -= amount1;
        _burn(msg.sender, lpAmount);

        if (amount0 > 0) token0.safeTransfer(msg.sender, amount0);
        if (amount1 > 0) token1.safeTransfer(msg.sender, amount1);

        emit RemoveLiquidity(msg.sender, amount0, amount1, lpAmount);
    }

    /// @notice Burn `lpAmount` LP and receive a single coin `i`. Charges the imbalance fee, since
    ///         a one-sided withdrawal pushes the pool away from balance.
    function removeLiquidityOneCoin(uint256 lpAmount, uint8 i, uint256 minAmount)
        external
        nonReentrant
        returns (uint256 dy)
    {
        if (lpAmount == 0) revert ZeroAmount();
        if (i >= N_COINS) revert InvalidCoin();

        uint256 amp = getA();
        dy = _calcWithdrawOneCoin(lpAmount, i, amp);
        if (dy < minAmount) revert InsufficientOutput();

        if (i == 0) {
            reserve0 -= dy;
        } else {
            reserve1 -= dy;
        }
        _burn(msg.sender, lpAmount);

        IERC20 tokenOut = i == 0 ? token0 : token1;
        tokenOut.safeTransfer(msg.sender, dy);

        emit RemoveLiquidityOneCoin(msg.sender, i, dy, lpAmount);
    }

    /// @notice Quote a single-coin withdrawal of `lpAmount` for coin `i` (fee included).
    function calcWithdrawOneCoin(uint256 lpAmount, uint8 i) external view returns (uint256) {
        if (i >= N_COINS) revert InvalidCoin();
        return _calcWithdrawOneCoin(lpAmount, i, getA());
    }

    /// @dev D0 = current invariant; D1 = invariant after burning lpAmount worth of D. Solve for the
    ///      new balance of coin i at D1 (the other coin held fixed), then charge the imbalance fee
    ///      on the difference between the fee-free withdrawal and the ideally-proportional one.
    function _calcWithdrawOneCoin(uint256 lpAmount, uint8 i, uint256 amp)
        internal
        view
        returns (uint256 dy)
    {
        // (kept to ≤10 locals via scoped block — 16-slot stack limit)
        uint256 d0 = _getD(reserve0, reserve1, amp);
        uint256 d1 = d0 - (d0 * lpAmount) / totalSupply();

        // Fee-free: solve new balance of coin i holding the OTHER coin's balance fixed at D1.
        uint256 other = i == 0 ? reserve1 : reserve0;
        uint256 balI = i == 0 ? reserve0 : reserve1;
        uint256 dyNoFee = balI - _getY(other, d1, amp);

        // Imbalance fee on the deviation of the *other* coin from its ideal proportional level.
        uint256 feeOnOther;
        {
            uint256 idealOther = (other * d1) / d0;
            feeOnOther = (_absDiff(idealOther, other) * feeBps) / BPS;
        }
        // Recompute coin i at D1 with the other coin reduced by its fee → tightens the payout.
        dy = balI - _getY(other - feeOnOther, d1, amp);
        if (dy > dyNoFee) dy = dyNoFee; // never pay more than the fee-free amount
    }
}
