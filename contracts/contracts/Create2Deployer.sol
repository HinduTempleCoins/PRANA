// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Create2Deployer — deterministic (CREATE2) contract deployer for PRANA.
/// @notice Deploys arbitrary creation code at an address that depends only on
///         (this deployer, salt, creationCode) — independent of deployer nonce. This lets the
///         same contract land at the SAME address across PRANA, sibling-chain helpers, and any
///         redeploy, which is essential for cross-chain/bridge wiring and address pre-commitment.
/// @dev Minimal and immutable: no owner, no pause. Anyone may deploy under any salt; addresses
///      are namespaced by msg.sender is NOT used here (pure CREATE2), so coordinate salts via
///      test-forge/SALTS.md to avoid collisions.
contract Create2Deployer {
    /// @notice Emitted on every successful deployment.
    event Deployed(address indexed addr, bytes32 indexed salt, address indexed deployer);

    error DeployFailed();
    error AlreadyDeployed(address addr);

    /// @notice Deploy `creationCode` (init code, incl. constructor args) at the CREATE2 address
    ///         for `salt`. Reverts if that address already holds code.
    /// @param salt 32-byte salt selecting the deterministic address.
    /// @param creationCode the full init code: `type(C).creationCode` abi.encodePacked with args.
    /// @return addr the address the contract was deployed to.
    function deploy(bytes32 salt, bytes memory creationCode) external returns (address addr) {
        address predicted = computeAddress(salt, keccak256(creationCode));
        if (predicted.code.length != 0) revert AlreadyDeployed(predicted);

        assembly {
            addr := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (addr == address(0)) revert DeployFailed();

        emit Deployed(addr, salt, msg.sender);
    }

    /// @notice Compute the CREATE2 address for a given salt and init-code hash, deployed by THIS
    ///         contract. `initCodeHash` = keccak256(creationCode).
    function computeAddress(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return computeAddress(salt, initCodeHash, address(this));
    }

    /// @notice Compute the CREATE2 address for an arbitrary `deployer`.
    function computeAddress(bytes32 salt, bytes32 initCodeHash, address deployer)
        public
        pure
        returns (address)
    {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash));
        return address(uint160(uint256(h)));
    }
}
