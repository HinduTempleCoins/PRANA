// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal view of the deploy-wizard. `createToken` deploys an ERC-20, mints
///      `initialMint` to `mintTo`, hands all roles to msg.sender, and returns the new
///      token address. The launchpad passes itself as `mintTo` so the freshly minted
///      supply is on hand to seed the pool in the same tx.
interface IERC20FactoryWizard {
    function createToken(
        string calldata name,
        string calldata symbol,
        uint256 cap,
        uint256 initialMint,
        address mintTo
    ) external returns (address token);
}

/// @dev Minimal view of the AMM factory.
interface IFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

/// @dev Minimal view of the AMM router used to seed liquidity.
interface IRouter {
    function factory() external view returns (address);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

/// @dev Minimal view of the optional liquidity locker. If a locker is configured, LP
///      tokens are time-locked for the caller instead of sent to them directly.
interface ILiquidityLocker {
    function lock(IERC20 token, uint256 amount, uint64 unlockTime, address owner)
        external
        returns (uint256 id);
}

/// @title TokenLaunchpad
/// @notice One-call token launch: deploy a new ERC-20 through the deploy-wizard, create its
///         AMM pair, and seed initial liquidity atomically in the same transaction so the
///         pool is tradable immediately.
/// @dev    Composes {IERC20FactoryWizard}, the AMM {IFactory}/{IRouter}, and an optional
///         {ILiquidityLocker} WITHOUT modifying any of them. Flow of {createTokenWithPool}:
///           1. wizard.createToken(..., mintTo = this) → mints `tokenLiquidity` to this
///              contract (cap must be >= tokenLiquidity) and returns the token address;
///           2. pull `counterLiquidity` of `counterAsset` from the caller;
///           3. approve the router and call addLiquidity (router creates the pair if needed);
///           4. LP tokens go to the caller, or — if `lockUntil` > 0 and a locker is set — are
///              time-locked for the caller in the locker.
///         The wizard already emits its own registry event (TokenCreated) for explorers; this
///         contract re-surfaces the link via {TokenLaunched}.
contract TokenLaunchpad {
    using SafeERC20 for IERC20;

    /// @notice The deploy-wizard that mints new ERC-20s.
    IERC20FactoryWizard public immutable wizard;

    /// @notice The AMM router used to seed liquidity.
    IRouter public immutable router;

    /// @notice The AMM factory (read from the router at construction).
    IFactory public immutable factory;

    /// @notice Optional LP locker (address(0) = locking unsupported; LP always goes to caller).
    ILiquidityLocker public immutable locker;

    struct LaunchParams {
        string name;
        string symbol;
        uint256 cap;       // hard cap on the new token (>= tokenLiquidity)
        uint256 lockUntil; // unix time to lock LP until; 0 = send LP straight to caller
    }

    event TokenLaunched(
        address indexed token,
        address indexed pair,
        address indexed creator,
        uint256 liquidity,
        uint256 lockId,
        bool locked
    );

    error ZeroTokenLiquidity();
    error ZeroCounterLiquidity();
    error ZeroCounterAsset();
    error CapBelowLiquidity();
    error LockerNotSet();
    error LockInPast();

    /// @param wizard_ The deploy-wizard.
    /// @param router_ The AMM router (its `factory()` is cached as {factory}).
    /// @param locker_ Optional LP locker; pass address(0) to disable the lock path.
    constructor(IERC20FactoryWizard wizard_, IRouter router_, ILiquidityLocker locker_) {
        wizard = wizard_;
        router = router_;
        factory = IFactory(router_.factory());
        locker = locker_;
    }

    /// @notice Launch a new ERC-20 and seed an AMM pool against `counterAsset` in one tx.
    /// @param params Token metadata + cap + optional LP lock time.
    /// @param counterAsset The existing ERC-20 paired against the new token (caller must
    ///        have approved this contract for `counterLiquidity`).
    /// @param tokenLiquidity New-token amount minted into the pool.
    /// @param counterLiquidity `counterAsset` amount pulled from the caller into the pool.
    /// @return token The newly deployed token address.
    /// @return pair The AMM pair address.
    /// @return liquidity LP tokens minted (held by caller or locked for them).
    function createTokenWithPool(
        LaunchParams calldata params,
        address counterAsset,
        uint256 tokenLiquidity,
        uint256 counterLiquidity
    ) external returns (address token, address pair, uint256 liquidity) {
        if (tokenLiquidity == 0) revert ZeroTokenLiquidity();
        if (counterLiquidity == 0) revert ZeroCounterLiquidity();
        if (counterAsset == address(0)) revert ZeroCounterAsset();
        if (params.cap < tokenLiquidity) revert CapBelowLiquidity();

        // 1. Deploy the token; mint the pool's new-token side to this contract.
        token = wizard.createToken(
            params.name,
            params.symbol,
            params.cap,
            tokenLiquidity,
            address(this)
        );

        // 2. Pull the counter asset from the caller.
        IERC20(counterAsset).safeTransferFrom(msg.sender, address(this), counterLiquidity);

        // 3. Ensure the pair exists, then seed liquidity through the router.
        pair = _ensurePair(token, counterAsset);
        liquidity = _seed(token, counterAsset, tokenLiquidity, counterLiquidity);

        // 4. Route the LP tokens (escrowed here by step 3) to the caller or the locker.
        (uint256 lockId, bool locked) = _deliverLp(pair, liquidity, params.lockUntil);

        emit TokenLaunched(token, pair, msg.sender, liquidity, lockId, locked);
    }

    /// @dev Create the pair if the factory does not already have one, returning its address.
    function _ensurePair(address token, address counterAsset) internal returns (address pair) {
        pair = factory.getPair(token, counterAsset);
        if (pair == address(0)) {
            pair = factory.createPair(token, counterAsset);
        }
    }

    /// @dev Approve the router for both legs and add liquidity, sending LP to this contract
    ///      so step 4 can route it (to caller or into the locker) atomically.
    function _seed(
        address token,
        address counterAsset,
        uint256 tokenLiquidity,
        uint256 counterLiquidity
    ) internal returns (uint256 liquidity) {
        IERC20(token).forceApprove(address(router), tokenLiquidity);
        IERC20(counterAsset).forceApprove(address(router), counterLiquidity);

        // Initial deposit into a fresh pair => router consumes exactly the desired amounts;
        // mins are set to the desired amounts to guard against a front-run that pre-seeds it.
        (, , liquidity) = router.addLiquidity(
            token,
            counterAsset,
            tokenLiquidity,
            counterLiquidity,
            tokenLiquidity,
            counterLiquidity,
            address(this),
            block.timestamp
        );
    }

    /// @dev Send LP straight to the caller, or time-lock it for the caller if requested.
    function _deliverLp(address pair, uint256 liquidity, uint256 lockUntil)
        internal
        returns (uint256 lockId, bool locked)
    {
        if (lockUntil == 0) {
            IERC20(pair).safeTransfer(msg.sender, liquidity);
            return (0, false);
        }

        if (address(locker) == address(0)) revert LockerNotSet();
        if (lockUntil <= block.timestamp) revert LockInPast();

        IERC20(pair).forceApprove(address(locker), liquidity);
        lockId = locker.lock(IERC20(pair), liquidity, uint64(lockUntil), msg.sender);
        locked = true;
    }
}
