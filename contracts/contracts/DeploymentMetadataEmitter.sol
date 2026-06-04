// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title DeploymentMetadataEmitter — make factory-deployed contracts explorer-verifiable
/// @notice A tiny, permissionless registry. After a factory (or a launchpad) deploys a contract,
///         it calls {recordDeployment} to publish the metadata an explorer needs to verify the
///         source: a `sourceId` (the keccak256 of the standard-JSON build/input — off-chain
///         tooling matches it to the verified source) plus the abi-encoded constructor args.
///
/// @dev    Permissionless: anyone may record for any address. To keep the registry trustworthy
///         it is FIRST-WRITE-WINS — exactly one record per deployed address; a second attempt
///         reverts with {AlreadyRecorded}. The event carries everything an indexer needs; this
///         contract holds no per-record storage beyond a "seen" flag.
contract DeploymentMetadataEmitter {
    /// @notice Tracks which deployed addresses already have a record (first-write-wins).
    mapping(address => bool) public recorded;

    /// @param deployed       The contract whose source is being made verifiable.
    /// @param sourceId       keccak256 of the standard-JSON build input (matched off-chain).
    /// @param constructorArgs ABI-encoded constructor arguments used at deploy time.
    /// @param recorder       Who submitted the record (msg.sender).
    event DeploymentMetadata(
        address indexed deployed,
        bytes32 indexed sourceId,
        bytes constructorArgs,
        address indexed recorder
    );

    error ZeroDeployment();
    error AlreadyRecorded(address deployed);

    /// @notice Publish verification metadata for `deployed`. Callable standalone by any factory
    ///         (e.g. {ERC20CloneFactory}) or directly by a launchpad/EOA.
    function recordDeployment(address deployed, bytes32 sourceId, bytes calldata constructorArgs) external {
        if (deployed == address(0)) revert ZeroDeployment();
        if (recorded[deployed]) revert AlreadyRecorded(deployed);
        recorded[deployed] = true;
        emit DeploymentMetadata(deployed, sourceId, constructorArgs, msg.sender);
    }
}
