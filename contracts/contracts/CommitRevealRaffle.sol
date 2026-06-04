// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CommitRevealRaffle
/// @notice A ticketed raffle whose winning ticket is drawn from a *future* blockhash
///         (a commit-reveal scheme). Tickets are bought at a fixed ERC-20 price; the
///         accumulated prize pool is paid out to the holder of the winning ticket.
///
///         Flow:
///           1. Entrants call `buyTicket(count)` while entries are open, paying
///              `ticketPrice` per ticket. Each ticket gets a sequential number and is
///              mapped to its buyer.
///           2. The owner calls `closeEntries()`, which fixes `drawBlock = block.number + N`.
///              No further tickets can be bought.
///           3. Once `block.number > drawBlock`, anyone calls `draw()`. The contract reads
///              `blockhash(drawBlock)` as the randomness source, derives a winning ticket,
///              and transfers the whole prize pool to that ticket's holder.
///
/// @dev HONEST RANDOMNESS LIMITATION: `blockhash` is influenced by the block producer
///      (miner/validator) of `drawBlock`. A producer can, within limits, choose to withhold
///      a block to bias the outcome, and `blockhash` is only available for the most recent
///      256 blocks. This commit-reveal-from-future-blockhash design is materially harder to
///      manipulate than a caller-supplied seed (the entrant cannot pick the seed, and the
///      block is not yet mined at commit time), but it is NOT manipulation-proof. For
///      production / high-value raffles, use a verifiable randomness beacon such as
///      Chainlink VRF. The 256-block expiry is handled here via `refundExpired()`, which
///      lets the owner re-arm the draw at a new future block.
contract CommitRevealRaffle is Ownable {
    using SafeERC20 for IERC20;

    /// @notice ERC-20 token used to buy tickets and to pay the prize.
    IERC20 public immutable token;

    /// @notice Price of a single ticket, in `token` base units.
    uint256 public immutable ticketPrice;

    /// @notice How many blocks ahead of `closeEntries()` the draw block is set.
    uint256 public immutable drawDelay;

    /// @notice Total tickets sold so far. Valid ticket numbers are [0, ticketCount).
    uint256 public ticketCount;

    /// @notice Accumulated prize pool (sum of all ticket purchases), in `token` base units.
    uint256 public prizePool;

    /// @notice Block whose hash will seed the draw. 0 until entries are closed.
    uint256 public drawBlock;

    /// @notice True once entries are closed and `drawBlock` is fixed.
    bool public entriesClosed;

    /// @notice True once the prize has been paid out.
    bool public drawn;

    /// @notice ticket number => buyer address.
    mapping(uint256 => address) public ticketOwner;

    event TicketsBought(address indexed buyer, uint256 firstTicket, uint256 count, uint256 paid);
    event EntriesClosed(uint256 drawBlock);
    event Drawn(address indexed winner, uint256 winningTicket, uint256 prize);
    event DrawReArmed(uint256 newDrawBlock);

    error EntriesAreClosed();
    error EntriesNotClosed();
    error AlreadyDrawn();
    error ZeroTickets();
    error NoTickets();
    error TooEarly();
    error BlockhashUnavailable();

    /// @param token_       ERC-20 used for tickets and prize.
    /// @param ticketPrice_ price per ticket (must be > 0).
    /// @param drawDelay_   blocks ahead of close to schedule the draw (e.g. 5; must be > 0).
    constructor(IERC20 token_, uint256 ticketPrice_, uint256 drawDelay_) Ownable(msg.sender) {
        require(address(token_) != address(0), "token=0");
        require(ticketPrice_ > 0, "price=0");
        require(drawDelay_ > 0, "delay=0");
        token = token_;
        ticketPrice = ticketPrice_;
        drawDelay = drawDelay_;
    }

    /// @notice Buy `count` tickets, paying `ticketPrice * count`. Entries must be open.
    /// @dev Pull-payment via SafeERC20; caller must have approved this contract.
    function buyTicket(uint256 count) external {
        if (entriesClosed) revert EntriesAreClosed();
        if (count == 0) revert ZeroTickets();

        uint256 firstTicket = ticketCount;
        uint256 cost = ticketPrice * count;

        for (uint256 i = 0; i < count; ++i) {
            ticketOwner[firstTicket + i] = msg.sender;
        }
        ticketCount = firstTicket + count;
        prizePool += cost;

        token.safeTransferFrom(msg.sender, address(this), cost);

        emit TicketsBought(msg.sender, firstTicket, count, cost);
    }

    /// @notice Owner closes entries and commits to a future block whose hash seeds the draw.
    function closeEntries() external onlyOwner {
        if (entriesClosed) revert EntriesAreClosed();
        if (ticketCount == 0) revert NoTickets();
        entriesClosed = true;
        drawBlock = block.number + drawDelay;
        emit EntriesClosed(drawBlock);
    }

    /// @notice Draw the winner once `drawBlock` has passed. Anyone may call.
    /// @dev Reverts if called before `drawBlock` is mined, or if `blockhash(drawBlock)`
    ///      is unavailable (0) because the block is too old (>256 behind) or not yet mined.
    function draw() external {
        if (!entriesClosed) revert EntriesNotClosed();
        if (drawn) revert AlreadyDrawn();
        // blockhash(drawBlock) is only non-zero once drawBlock has been mined AND is within
        // the last 256 blocks. Require we are strictly past it.
        if (block.number <= drawBlock) revert TooEarly();

        bytes32 bh = blockhash(drawBlock);
        if (bh == bytes32(0)) revert BlockhashUnavailable();

        drawn = true;
        uint256 winningTicket = uint256(keccak256(abi.encodePacked(bh, drawBlock))) % ticketCount;
        address winner = ticketOwner[winningTicket];

        uint256 prize = prizePool;
        prizePool = 0;
        token.safeTransfer(winner, prize);

        emit Drawn(winner, winningTicket, prize);
    }

    /// @notice Re-arm the draw at a new future block if `blockhash(drawBlock)` expired
    ///         (more than 256 blocks elapsed before anyone called `draw()`).
    /// @dev Tickets and prize pool are preserved; only the seed block is reset. This is the
    ///      "refund/retry" path: nobody loses their entry, the draw is simply rescheduled.
    function refundExpired() external onlyOwner {
        if (!entriesClosed) revert EntriesNotClosed();
        if (drawn) revert AlreadyDrawn();
        // Only allow re-arming once the old drawBlock's hash is genuinely unavailable.
        if (block.number <= drawBlock) revert TooEarly();
        if (blockhash(drawBlock) != bytes32(0)) revert BlockhashUnavailable(); // still drawable

        drawBlock = block.number + drawDelay;
        emit DrawReArmed(drawBlock);
    }
}
