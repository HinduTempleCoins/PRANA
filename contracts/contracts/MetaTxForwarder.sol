// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @title MetaTxForwarder
/// @notice Trusted forwarder for ERC-2771 gasless meta-transactions on PRANA.
/// A relayer submits an EIP-712 signed ForwardRequest on behalf of a user; the
/// recipient contract (ERC2771Context) recovers the original signer as msg.sender,
/// so users can interact without holding native PRANA for gas.
contract MetaTxForwarder is ERC2771Forwarder {
    /// @dev EIP-712 domain name is "MetaTxForwarder", version "1".
    constructor() ERC2771Forwarder("MetaTxForwarder") {}
}
