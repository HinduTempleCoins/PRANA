// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IHumanVerifier} from "../DataDAO.sol";

/// @notice Test-only stand-in for the planned ProofOfHumanCredential / ReputationRegistry module.
///         Lets tests flip a contributor's verified-human status on and off.
contract MockHumanVerifier is IHumanVerifier {
    mapping(address => bool) public verified;

    function setVerified(address account, bool v) external {
        verified[account] = v;
    }

    function isVerifiedHuman(address account) external view returns (bool) {
        return verified[account];
    }
}
