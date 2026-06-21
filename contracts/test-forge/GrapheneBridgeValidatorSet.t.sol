// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {GrapheneDepositBridge} from "../contracts/bridge/GrapheneDepositBridge.sol";
import {FederatedBridgeValidatorSet} from "../contracts/bridge/FederatedBridgeValidatorSet.sol";

/// @title GrapheneBridgeValidatorSet wiring regression (X-2)
/// @notice Proves the GrapheneDepositBridge works when wired to the REAL {FederatedBridgeValidatorSet},
///         not just the mock. The bridge used to call `validatorSet.quorum()` while the federated set
///         only implements `threshold()` — so every read of the quorum (and thus every `attestDeposit`)
///         REVERTED once the real set was wired, DoSing inbound deposits and pushing the operator to the
///         weaker built-in single-admin mode. The mock exposed `quorum()`, so the Hardhat suite was green
///         while production was broken. This test deploys the real set and would have caught it.
contract GrapheneBridgeValidatorSetTest is Test {
    GrapheneDepositBridge bridge;
    FederatedBridgeValidatorSet vset;

    address admin = address(0xA11CE);
    address v1 = address(0x1111);
    address v2 = address(0x2222);
    address v3 = address(0x3333);

    function setUp() public {
        address[] memory validators = new address[](3);
        validators[0] = v1;
        validators[1] = v2;
        validators[2] = v3;
        // N = 3, K (threshold) = 2
        vset = new FederatedBridgeValidatorSet(admin, validators, 2);
        bridge = new GrapheneDepositBridge(admin, address(vset));
    }

    /// The bridge reads K from the federated set's threshold() without reverting, and gets the right K.
    function test_requiredQuorum_readsFederatedThreshold() public view {
        assertEq(bridge.requiredQuorum(), 2, "bridge must read the federated K (threshold), not revert");
    }

    /// The bridge resolves attester membership through the federated set, too.
    function test_isAttester_readsFederatedMembership() public view {
        assertTrue(bridge.isAttester(v1), "federated validator must be an attester");
        assertFalse(bridge.isAttester(address(0xBEEF)), "non-validator must not be an attester");
    }

    /// Raising the federated threshold flows straight through (no stale cached quorum on the bridge).
    function test_thresholdChangeFlowsThrough() public {
        vm.prank(admin);
        vset.setThreshold(3);
        assertEq(bridge.requiredQuorum(), 3, "bridge must reflect the live federated threshold");
    }
}
