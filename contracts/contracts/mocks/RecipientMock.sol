// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @notice Test-only ERC-2771 recipient. Records the resolved meta-tx sender so tests
/// can assert the ORIGINAL signer (not the forwarder) is seen as the caller.
contract RecipientMock is ERC2771Context {
    address public lastCaller;

    constructor(address forwarder) ERC2771Context(forwarder) {}

    function ping() external {
        lastCaller = _msgSender();
    }
}
