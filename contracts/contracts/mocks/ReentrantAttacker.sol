// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Test-only generic reentrancy attacker.
/// @dev Configurable: point it at any `target` with an arbitrary `payload` (the encoded
///      call to re-enter). When ARMED, it fires that call back into the target from inside
///      a callback (native `receive()`, ERC-721 `onERC721Received`, or the ERC-20-style
///      `onTokenTransfer` hook offered by ReentrantToken below). It records the maximum
///      re-entry depth reached and the last revert reason, and auto-disarms after `maxDepth`
///      so a successful re-entry can be observed without infinite recursion.
///
///      Usage in tests: deploy, `arm(target, payload, maxDepth)`, trigger the victim path
///      that sends value / a token / an NFT to this contract, then read `depthReached`
///      and `reenterSucceeded` to learn whether the victim was actually re-enterable.
contract ReentrantAttacker is IERC721Receiver {
    bool public armed;
    address public target;
    bytes public payload;
    uint256 public maxDepth;

    uint256 public depthReached;   // deepest nesting observed across the run
    uint256 private _curDepth;     // current live nesting
    bool public reenterSucceeded;  // true if at least one re-entrant call returned ok
    bool public reenterAttempted;  // true if we ever fired the re-entrant call
    bytes public lastRevert;       // raw revert data of the last failed re-entry (if any)

    /// @notice Configure the attack. `payload_` is the abi-encoded call re-entered into `target_`.
    function arm(address target_, bytes calldata payload_, uint256 maxDepth_) external {
        armed = true;
        target = target_;
        payload = payload_;
        maxDepth = maxDepth_ == 0 ? 1 : maxDepth_;
        // reset run state so the same attacker can be reused across cases
        depthReached = 0;
        _curDepth = 0;
        reenterSucceeded = false;
        reenterAttempted = false;
        lastRevert = "";
    }

    function disarm() external {
        armed = false;
    }

    /// @notice Forward an arbitrary call to the target as the initial (non-re-entrant) action,
    ///         e.g. to kick off a withdrawal/claim/release that then pays this contract back.
    function fire(address target_, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target_.call(data);
    }

    /// @dev The heart of the attack: re-enter `target` while still inside the victim's
    ///      external call, up to `maxDepth`. Auto-disarms at the cap so the outer victim
    ///      call can complete and we can inspect the result.
    function _reenter() internal {
        if (!armed) return;
        if (_curDepth >= maxDepth) {
            armed = false; // stop recursing; let the outer frame unwind
            return;
        }
        _curDepth += 1;
        if (_curDepth > depthReached) depthReached = _curDepth;
        reenterAttempted = true;

        (bool ok, bytes memory ret) = target.call(payload);
        if (ok) {
            reenterSucceeded = true;
        } else {
            lastRevert = ret;
        }

        _curDepth -= 1;
    }

    // --- callback entry points the victim may trigger ---

    receive() external payable {
        _reenter();
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        _reenter();
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice ERC-20-style transfer hook (fired by ReentrantToken on each transfer to us).
    function onTokenTransfer(address, address, uint256) external {
        _reenter();
    }

    /// @dev Let tests fund / approve as if this were an EOA acting as the malicious user.
    function approveToken(address token, address spender, uint256 amount) external {
        (bool ok, ) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        require(ok, "approve failed");
    }
}

/// @notice Test-only ERC-20 that invokes `onTokenTransfer` on the recipient (if it is a
///         contract) after every balance move — a hostile token used to probe whether a
///         victim contract is safe against re-entrancy driven through the token leg of an
///         external transfer. Mirrors the ERC-777/callback class of token without pulling
///         in the full standard.
contract ReentrantToken {
    string public name = "Reentrant";
    string public symbol = "RNT";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        // Hostile hook: hand control to the recipient mid-transfer if it is a contract.
        if (to.code.length > 0) {
            // Best-effort; ignore failures so a guard-less recipient still receives funds.
            to.call(abi.encodeWithSignature("onTokenTransfer(address,address,uint256)", from, to, amount));
        }
    }
}
