// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title NoLossLotto — PoolTogether-style no-loss prize savings (hardened draw)
/// @notice Deposits are always withdrawable (principal is NEVER at risk). A sponsor funds the prize
///         pool (in production: the yield earned on deposits); a draw picks a winner weighted by
///         deposit size and pays ONLY the prize pool. Sidesteps the gambling problem: you can only
///         win, never lose your principal.
/// @dev    SECURITY (closes the threat-model TOP finding): the original `draw(seed)` let ANY caller
///         supply the seed, so the caller could pick the winner. This version uses the same
///         commit-reveal RNG pattern as {GachaMintOnCommit}: an authorized DRAW_ROLE holder commits
///         to a draw at the current block, and a later `revealDraw` derives the seed from a
///         future blockhash (unknowable at commit time) MIXED with the committer and a committed
///         salt hash. Because the salt is hash-committed before the blockhash is known and the
///         blockhash is fixed before the salt is revealed, neither the committer nor a colluding
///         miner can grind the seed to force a particular winner. The no-loss accounting is intact.
contract NoLossLotto is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice May commit/reveal a draw. Granted to the deployer-provided admin at construction.
    bytes32 public constant DRAW_ROLE = keccak256("DRAW_ROLE");

    /// @notice Reveal target is commitBlock+1; usable until block.number <= commitBlock + 256.
    uint256 public constant EXPIRY_BLOCKS = 256;

    IERC20 public immutable token;
    address[] public depositors;
    mapping(address => bool) private seen;
    mapping(address => uint256) public deposits;
    uint256 public totalDeposits;
    uint256 public prizePool;

    struct DrawCommit {
        uint256 commitBlock; // block.number at commit (0 = none open)
        bytes32 saltHash;    // keccak256(abi.encodePacked(salt)) supplied at commit
    }

    /// @notice The single open draw commitment (one draw at a time).
    DrawCommit public drawCommit;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event PrizeAdded(uint256 amount);
    event DrawCommitted(address indexed by, uint256 commitBlock, bytes32 saltHash);
    event Winner(address indexed winner, uint256 prize);

    error ZeroToken();
    error ZeroAmount();
    error BadWithdraw();
    error NothingToDraw();
    error ZeroSaltHash();
    error CommitOpen();
    error NoCommit();
    error TooEarly();
    error TooLate();
    error BadSalt();

    constructor(IERC20 token_, address admin) {
        if (address(token_) == address(0)) revert ZeroToken();
        if (admin == address(0)) revert ZeroToken();
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DRAW_ROLE, admin);
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (!seen[msg.sender]) {
            seen[msg.sender] = true;
            depositors.push(msg.sender);
        }
        deposits[msg.sender] += amount;
        totalDeposits += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0 || deposits[msg.sender] < amount) revert BadWithdraw();
        deposits[msg.sender] -= amount;
        totalDeposits -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function addPrize(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        prizePool += amount;
        emit PrizeAdded(amount);
    }

    /// @notice Helper to compute the salt hash a {commitDraw} caller must pass. Keep `salt` secret
    ///         until {revealDraw}.
    function saltHashOf(bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt));
    }

    /// @notice Authorized: open a draw by committing to a salt hash at the current block. The seed
    ///         is later derived from blockhash(commitBlock+1), unknowable now.
    /// @param saltHash keccak256(abi.encodePacked(salt)) for a secret `salt`. Non-zero.
    function commitDraw(bytes32 saltHash) external onlyRole(DRAW_ROLE) {
        if (saltHash == bytes32(0)) revert ZeroSaltHash();
        if (drawCommit.commitBlock != 0) revert CommitOpen();
        if (totalDeposits == 0 || prizePool == 0) revert NothingToDraw();
        drawCommit = DrawCommit({commitBlock: block.number, saltHash: saltHash});
        emit DrawCommitted(msg.sender, block.number, saltHash);
    }

    /// @notice Authorized: reveal the committed draw. Verifies the salt, derives the seed from the
    ///         future blockhash mixed with the committer and salt, picks a winner weighted by
    ///         deposit size, and pays out ONLY the prize pool. No caller can force the winner: the
    ///         seed was unknowable when the salt was committed.
    /// @param salt The secret pre-image whose keccak256 was supplied to {commitDraw}.
    function revealDraw(bytes32 salt) external onlyRole(DRAW_ROLE) returns (address winner) {
        DrawCommit memory c = drawCommit;
        if (c.commitBlock == 0) revert NoCommit();
        if (keccak256(abi.encodePacked(salt)) != c.saltHash) revert BadSalt();

        uint256 revealBlock = c.commitBlock + 1;
        if (block.number <= revealBlock) revert TooEarly();

        bytes32 bh = blockhash(revealBlock);
        if (bh == bytes32(0)) revert TooLate(); // outside the 256-block lookback window

        // Effects: clear the commit before paying out.
        delete drawCommit;
        if (totalDeposits == 0 || prizePool == 0) revert NothingToDraw();

        uint256 seed = uint256(keccak256(abi.encodePacked(bh, msg.sender, salt)));
        uint256 pick = seed % totalDeposits;
        uint256 cumulative;
        for (uint256 i; i < depositors.length; i++) {
            cumulative += deposits[depositors[i]];
            if (pick < cumulative) {
                winner = depositors[i];
                break;
            }
        }

        uint256 prize = prizePool;
        prizePool = 0;
        token.safeTransfer(winner, prize);
        emit Winner(winner, prize);
    }

    /// @notice Authorized: clear an expired (unrevealable) draw commit so a fresh one can open.
    function clearExpiredDraw() external onlyRole(DRAW_ROLE) {
        uint256 cb = drawCommit.commitBlock;
        if (cb == 0) revert NoCommit();
        if (block.number <= cb + EXPIRY_BLOCKS) revert TooEarly();
        delete drawCommit;
    }

    function depositorCount() external view returns (uint256) {
        return depositors.length;
    }
}
