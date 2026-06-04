// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Escrow
/// @notice An ERC-20 escrow with a neutral arbiter. A buyer opens an escrow by
///         pulling funds in; the named arbiter then either releases the funds to
///         the seller or refunds them to the buyer. Each escrow resolves once.
contract Escrow {
    using SafeERC20 for IERC20;

    enum State {
        None, // 0 - never created
        Funded, // 1 - funds held, awaiting arbiter
        Released, // 2 - paid to seller
        Refunded // 3 - returned to buyer
    }

    struct Deal {
        address buyer;
        address seller;
        address arbiter;
        IERC20 token;
        uint256 amount;
        State state;
    }

    uint256 public nextId;
    mapping(uint256 => Deal) public escrows;

    event Opened(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        address arbiter,
        address token,
        uint256 amount
    );
    event Released(uint256 indexed id, address indexed seller, uint256 amount);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);

    /// @notice Open a new escrow. Caller is the buyer; `amount` is pulled from the
    ///         caller (who must have approved this contract) and held until resolved.
    /// @return id The newly created escrow id.
    function open(
        address seller,
        address arbiter,
        IERC20 token,
        uint256 amount
    ) external returns (uint256 id) {
        require(seller != address(0), "Escrow: seller=0");
        require(arbiter != address(0), "Escrow: arbiter=0");
        require(address(token) != address(0), "Escrow: token=0");
        require(amount > 0, "Escrow: amount=0");

        id = nextId++;
        escrows[id] = Deal({
            buyer: msg.sender,
            seller: seller,
            arbiter: arbiter,
            token: token,
            amount: amount,
            state: State.Funded
        });

        // Pull funds in. SafeERC20 reverts on failure / non-standard tokens.
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Opened(id, msg.sender, seller, arbiter, address(token), amount);
    }

    /// @notice Arbiter releases the escrowed funds to the seller.
    function release(uint256 id) external {
        Deal storage d = escrows[id];
        require(d.state == State.Funded, "Escrow: not funded");
        require(msg.sender == d.arbiter, "Escrow: not arbiter");

        d.state = State.Released;
        d.token.safeTransfer(d.seller, d.amount);

        emit Released(id, d.seller, d.amount);
    }

    /// @notice Arbiter refunds the escrowed funds back to the buyer.
    function refund(uint256 id) external {
        Deal storage d = escrows[id];
        require(d.state == State.Funded, "Escrow: not funded");
        require(msg.sender == d.arbiter, "Escrow: not arbiter");

        d.state = State.Refunded;
        d.token.safeTransfer(d.buyer, d.amount);

        emit Refunded(id, d.buyer, d.amount);
    }
}
