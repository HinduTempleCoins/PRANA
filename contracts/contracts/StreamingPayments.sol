// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Sablier-style linear token streams. A sender locks `total` tokens to be
///         released to a recipient at a constant rate between `start` and `stop`.
contract StreamingPayments {
    using SafeERC20 for IERC20;

    struct Stream {
        address sender;
        address recipient;
        IERC20 token;
        uint256 total;      // total tokens deposited for the stream
        uint256 withdrawn;  // tokens already withdrawn by the recipient
        uint64 start;       // unix time the stream begins releasing
        uint64 stop;        // unix time the stream is fully released
        bool active;        // false once cancelled or fully consumed
    }

    uint256 public nextStreamId;
    mapping(uint256 => Stream) private _streams;

    event StreamCreated(
        uint256 indexed id,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 total,
        uint64 start,
        uint64 stop
    );
    event Withdraw(uint256 indexed id, address indexed recipient, uint256 amount);
    event StreamCancelled(uint256 indexed id, uint256 recipientBalance, uint256 senderBalance);

    /// @notice Create a stream, pulling `total` tokens from the caller into this contract.
    /// @return id The new stream id.
    function createStream(
        address recipient,
        IERC20 token,
        uint256 total,
        uint64 start,
        uint64 stop
    ) external returns (uint256 id) {
        require(recipient != address(0), "bad recipient");
        require(recipient != address(this), "bad recipient");
        require(total > 0, "zero total");
        require(stop > start, "stop<=start");
        // require the stream to be evenly divisible so per-second math is exact
        require(total % (uint256(stop) - uint256(start)) == 0, "total not divisible");

        id = nextStreamId++;
        _streams[id] = Stream({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            total: total,
            withdrawn: 0,
            start: start,
            stop: stop,
            active: true
        });

        token.safeTransferFrom(msg.sender, address(this), total);

        emit StreamCreated(id, msg.sender, recipient, address(token), total, start, stop);
    }

    /// @notice Tokens streamed so far by `timestamp`, capped at total (0 before start).
    function _streamedAt(Stream storage s, uint256 timestamp) private view returns (uint256) {
        if (timestamp <= s.start) {
            return 0;
        }
        if (timestamp >= s.stop) {
            return s.total;
        }
        uint256 elapsed = timestamp - uint256(s.start);
        uint256 duration = uint256(s.stop) - uint256(s.start);
        return (s.total * elapsed) / duration;
    }

    /// @notice Amount the recipient can withdraw right now (streamed-so-far minus withdrawn).
    function withdrawable(uint256 id) public view returns (uint256) {
        Stream storage s = _streams[id];
        require(s.recipient != address(0), "no stream");
        uint256 streamed = _streamedAt(s, block.timestamp);
        return streamed - s.withdrawn;
    }

    /// @notice Recipient withdraws up to `withdrawable(id)` tokens.
    function withdraw(uint256 id, uint256 amount) external {
        Stream storage s = _streams[id];
        require(s.active, "inactive");
        require(msg.sender == s.recipient, "not recipient");
        require(amount > 0, "zero amount");

        uint256 avail = withdrawable(id);
        require(amount <= avail, "exceeds withdrawable");

        s.withdrawn += amount;
        s.token.safeTransfer(s.recipient, amount);

        emit Withdraw(id, s.recipient, amount);
    }

    /// @notice Cancel a stream: pay the recipient the streamed-but-unwithdrawn portion and
    ///         refund the remainder to the sender. Callable by sender or recipient.
    function cancelStream(uint256 id) external {
        Stream storage s = _streams[id];
        require(s.active, "inactive");
        require(msg.sender == s.sender || msg.sender == s.recipient, "not party");

        uint256 streamed = _streamedAt(s, block.timestamp);
        uint256 recipientBalance = streamed - s.withdrawn; // owed to recipient now
        uint256 senderBalance = s.total - streamed;        // unstreamed remainder

        s.active = false;
        s.withdrawn = s.total; // prevent any further withdrawal accounting

        if (recipientBalance > 0) {
            s.token.safeTransfer(s.recipient, recipientBalance);
        }
        if (senderBalance > 0) {
            s.token.safeTransfer(s.sender, senderBalance);
        }

        emit StreamCancelled(id, recipientBalance, senderBalance);
    }

    /// @notice Read a stream's stored data.
    function getStream(uint256 id)
        external
        view
        returns (
            address sender,
            address recipient,
            address token,
            uint256 total,
            uint256 withdrawn,
            uint64 start,
            uint64 stop,
            bool active
        )
    {
        Stream storage s = _streams[id];
        require(s.recipient != address(0), "no stream");
        return (s.sender, s.recipient, address(s.token), s.total, s.withdrawn, s.start, s.stop, s.active);
    }
}
