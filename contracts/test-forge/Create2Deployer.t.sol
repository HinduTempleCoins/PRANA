// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Create2Deployer} from "../contracts/Create2Deployer.sol";
import {BaseTest} from "./helpers/BaseTest.sol";
import {FixtureERC20} from "./helpers/Fixtures.sol";

contract Create2DeployerTest is BaseTest {
    Create2Deployer internal factory;

    function setUp() public override {
        super.setUp();
        factory = new Create2Deployer();
    }

    /// Build the init code for a FixtureERC20("Det","DET",18).
    function _initCode() internal pure returns (bytes memory) {
        return abi.encodePacked(type(FixtureERC20).creationCode, abi.encode(string("Det"), string("DET"), uint8(18)));
    }

    function test_computeAddress_matches_actual_deploy() public {
        bytes memory code = _initCode();
        bytes32 salt = keccak256("prana.fixture.v1");

        address predicted = factory.computeAddress(salt, keccak256(code));
        address actual = factory.deploy(salt, code);

        assertEq(actual, predicted, "predicted != actual");
        assertGt(actual.code.length, 0, "no code at deployed address");
    }

    function test_deployed_contract_is_functional() public {
        bytes memory code = _initCode();
        bytes32 salt = bytes32(uint256(0xABCD));

        address addr = factory.deploy(salt, code);
        FixtureERC20 token = FixtureERC20(addr);

        token.mint(alice, 1_000 ether);
        assertEq(token.balanceOf(alice), 1_000 ether);
        assertEq(token.decimals(), 18);
    }

    function test_same_salt_same_address_is_deterministic() public view {
        bytes memory code = _initCode();
        bytes32 salt = keccak256("same");
        address a = factory.computeAddress(salt, keccak256(code));
        address b = factory.computeAddress(salt, keccak256(code));
        assertEq(a, b);
    }

    function test_different_salt_different_address() public view {
        bytes32 h = keccak256(_initCode());
        address a = factory.computeAddress(keccak256("salt.a"), h);
        address b = factory.computeAddress(keccak256("salt.b"), h);
        assertTrue(a != b, "distinct salts collided");
    }

    function test_redeploy_same_salt_reverts() public {
        bytes memory code = _initCode();
        bytes32 salt = keccak256("once");
        address addr = factory.deploy(salt, code);

        vm.expectRevert(abi.encodeWithSelector(Create2Deployer.AlreadyDeployed.selector, addr));
        factory.deploy(salt, code);
    }

    function testFuzz_compute_is_pure_function_of_inputs(bytes32 salt, bytes32 initCodeHash) public view {
        address x = factory.computeAddress(salt, initCodeHash, address(factory));
        address y = factory.computeAddress(salt, initCodeHash, address(factory));
        assertEq(x, y);
    }

    function test_arbitrary_deployer_overload_independent_of_this() public view {
        bytes32 h = keccak256(_initCode());
        bytes32 salt = keccak256("x");
        address viaThis = factory.computeAddress(salt, h);
        address viaArg = factory.computeAddress(salt, h, address(factory));
        assertEq(viaThis, viaArg, "overloads disagree for same deployer");

        address viaOther = factory.computeAddress(salt, h, address(0xBEEF));
        assertTrue(viaOther != viaThis, "different deployer should differ");
    }
}
