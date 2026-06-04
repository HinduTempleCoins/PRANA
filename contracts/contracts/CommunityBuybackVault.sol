// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal view of the PRANA AMM `UniswapV2Router` — only the two functions this vault uses.
///         Matches the real signatures in `contracts/amm/UniswapV2Router.sol`.
interface IUniswapV2RouterMinimal {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] memory path)
        external
        view
        returns (uint256[] memory amounts);
}

/// @title CommunityBuybackVault — curation rewards → AMM buyback → burn or redistribute
/// @notice A community account accrues curation/witness-style rewards as an inflow of `tokenIn`
///         (token A). A keeper/DAO triggers a buyback: the vault swaps its `tokenIn` balance for
///         `tokenOut` (token B) on the PRANA V2 router, then either:
///           - BURN mode:        burns the bought `tokenOut` (deflationary sink), or
///           - DISTRIBUTE mode:  sends the bought `tokenOut` to the community recipient.
///         The active mode is owner-configurable.
/// @dev Wired to the existing `contracts/amm/UniswapV2Router.sol` (the Uniswap-V2 fork on PRANA)
///      via `IUniswapV2RouterMinimal`. The swap is slippage-guarded by a caller-supplied `minOut`
///      (the keeper computes it off-chain or via `quoteBuyback`). The trigger is role-gated to
///      KEEPER_ROLE (a keeper bot or the DAO timelock). BURN mode requires `tokenOut` to be
///      ERC20Burnable.
contract CommunityBuybackVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice What to do with the bought-back `tokenOut`.
    enum Mode {
        Burn, // buyback-and-burn (deflationary sink)
        Distribute // buyback-and-distribute (return to the community recipient)
    }

    /// @notice The reward inflow token (token A) that the community earns and the vault spends.
    IERC20 public immutable tokenIn;
    /// @notice The token the vault buys back (token B).
    IERC20 public immutable tokenOut;
    /// @notice The PRANA AMM router used for the swap.
    IUniswapV2RouterMinimal public immutable router;

    /// @notice Active disposition of bought `tokenOut`.
    Mode public mode;
    /// @notice Recipient of bought `tokenOut` in DISTRIBUTE mode (e.g. the community treasury).
    address public communityRecipient;

    error ZeroAddress();
    error ZeroAmount();
    error NotBurnable();
    error DeadlineInPast();

    event ModeSet(Mode mode);
    event CommunityRecipientSet(address indexed recipient);
    event Buyback(address indexed keeper, uint256 amountIn, uint256 amountOut, Mode mode);
    event Burned(uint256 amount);
    event Distributed(address indexed to, uint256 amount);
    event Deposited(address indexed from, uint256 amount);

    /// @param admin              DEFAULT_ADMIN_ROLE (the DAO / timelock).
    /// @param keeper             initial KEEPER_ROLE holder (keeper bot or DAO).
    /// @param router_            the PRANA UniswapV2Router.
    /// @param tokenIn_           reward inflow token (token A).
    /// @param tokenOut_          buyback target token (token B).
    /// @param mode_              starting disposition mode.
    /// @param communityRecipient_ recipient for DISTRIBUTE mode (may be zero if starting in BURN).
    constructor(
        address admin,
        address keeper,
        IUniswapV2RouterMinimal router_,
        IERC20 tokenIn_,
        IERC20 tokenOut_,
        Mode mode_,
        address communityRecipient_
    ) {
        if (
            admin == address(0) ||
            keeper == address(0) ||
            address(router_) == address(0) ||
            address(tokenIn_) == address(0) ||
            address(tokenOut_) == address(0)
        ) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);

        router = router_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        mode = mode_;
        communityRecipient = communityRecipient_;

        emit ModeSet(mode_);
        emit CommunityRecipientSet(communityRecipient_);
    }

    // --------------------------------------------------------------------- //
    //                              Governance                               //
    // --------------------------------------------------------------------- //

    /// @notice Switch between buyback-and-burn and buyback-and-distribute.
    function setMode(Mode mode_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        mode = mode_;
        emit ModeSet(mode_);
    }

    /// @notice Set the recipient used in DISTRIBUTE mode.
    function setCommunityRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        communityRecipient = recipient;
        emit CommunityRecipientSet(recipient);
    }

    /// @notice Grant/revoke the keeper trigger role.
    function setKeeper(address keeper, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (keeper == address(0)) revert ZeroAddress();
        if (enabled) _grantRole(KEEPER_ROLE, keeper);
        else _revokeRole(KEEPER_ROLE, keeper);
    }

    // --------------------------------------------------------------------- //
    //                                Inflow                                 //
    // --------------------------------------------------------------------- //

    /// @notice Optional helper to pull `amount` of `tokenIn` from the caller into the vault.
    ///         (Curation rewards can also just be transferred in directly — the vault swaps
    ///          whatever balance it holds.)
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        tokenIn.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Pending `tokenIn` available to spend on the next buyback.
    function pending() external view returns (uint256) {
        return tokenIn.balanceOf(address(this));
    }

    /// @notice Quote the `tokenOut` received for swapping the vault's whole `tokenIn` balance
    ///         along `path`. Keepers use this to compute a `minOut` with their slippage budget.
    function quoteBuyback(address[] calldata path) external view returns (uint256 amountOut) {
        uint256 amountIn = tokenIn.balanceOf(address(this));
        if (amountIn == 0) return 0;
        uint256[] memory amounts = router.getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    }

    // --------------------------------------------------------------------- //
    //                               Buyback                                 //
    // --------------------------------------------------------------------- //

    /// @notice Spend the vault's whole `tokenIn` balance to buy `tokenOut` on the AMM, then burn
    ///         or distribute the proceeds per the active mode.
    /// @param path     swap path; must start at `tokenIn` and end at `tokenOut`.
    /// @param minOut   slippage guard — minimum acceptable `tokenOut` (router reverts below this).
    /// @param deadline swap deadline passed to the router.
    /// @return amountIn  `tokenIn` spent.
    /// @return amountOut `tokenOut` received.
    function buyback(address[] calldata path, uint256 minOut, uint256 deadline)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (path.length < 2 || path[0] != address(tokenIn) || path[path.length - 1] != address(tokenOut)) {
            revert ZeroAddress();
        }
        if (deadline < block.timestamp) revert DeadlineInPast();

        amountIn = tokenIn.balanceOf(address(this));
        if (amountIn == 0) revert ZeroAmount();

        // Approve exactly what we spend; reset to zero first for non-standard ERC-20s.
        tokenIn.forceApprove(address(router), amountIn);

        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            deadline
        );
        amountOut = amounts[amounts.length - 1];

        if (mode == Mode.Burn) {
            ERC20Burnable(address(tokenOut)).burn(amountOut);
            emit Burned(amountOut);
        } else {
            address to = communityRecipient;
            if (to == address(0)) revert ZeroAddress();
            tokenOut.safeTransfer(to, amountOut);
            emit Distributed(to, amountOut);
        }

        emit Buyback(msg.sender, amountIn, amountOut, mode);
    }

    /// @notice DAO escape hatch — recover any stranded token.
    function rescue(IERC20 token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }
}
