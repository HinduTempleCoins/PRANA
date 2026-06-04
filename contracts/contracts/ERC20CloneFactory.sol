// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC20Initializable} from "./ERC20Initializable.sol";
import {DeploymentMetadataEmitter} from "./DeploymentMetadataEmitter.sol";

/// @title ERC20CloneFactory — gas-cheap mass deployment of ERC-20s via EIP-1167 clones
/// @notice Deploys {ERC20Initializable} clones (a few hundred gas of bytecode each vs a full
///         contract deploy) and initializes them ATOMICALLY in the same tx (so nobody can
///         front-run the init). Supports both non-deterministic ({createToken}) and
///         deterministic CREATE2 ({createTokenDeterministic} + {predictAddress}) addresses for
///         counterfactual UX (frontend can show the token address before the tx confirms).
///
/// @dev    Like {ERC20FactoryWizard}: the factory is the clone's initial admin so it can mint an
///         optional initial supply, then it grants every role to the creator and renounces its
///         own — the factory is never a backdoor. If a {DeploymentMetadataEmitter} is wired, the
///         factory also records explorer-verification metadata for each clone.
contract ERC20CloneFactory {
    /// @notice The shared logic contract all clones DELEGATECALL into.
    address public immutable implementation;

    /// @notice Optional metadata emitter for explorer verification (address(0) = disabled).
    DeploymentMetadataEmitter public immutable metadataEmitter;

    /// @notice keccak256 of the standard-JSON build of {ERC20Initializable}; off-chain tooling
    ///         matches this to the verified source. Provided by the deployer at construction.
    bytes32 public immutable sourceId;

    address[] public allTokens;
    mapping(address => address) public creatorOf;

    event CloneCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 cap,
        bytes32 salt
    );

    error MintToZero();
    error CapBelowInitialMint(uint256 cap, uint256 initialMint);

    /// @param metadataEmitter_ Optional explorer-metadata registry; pass address(0) to disable.
    /// @param sourceId_        keccak256 of the standard-JSON build of the clone implementation.
    constructor(DeploymentMetadataEmitter metadataEmitter_, bytes32 sourceId_) {
        // Deploy one canonical implementation; its constructor self-bricks it.
        implementation = address(new ERC20Initializable());
        metadataEmitter = metadataEmitter_;
        sourceId = sourceId_;
    }

    /// @notice Deploy a clone at a non-deterministic (CREATE) address.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint256 cap,
        uint256 initialMint,
        address mintTo
    ) external returns (address token) {
        token = _finalize(Clones.clone(implementation), name, symbol, cap, initialMint, mintTo, bytes32(0));
    }

    /// @notice Deploy a clone at a deterministic (CREATE2) address fixed by `salt`.
    function createTokenDeterministic(
        string calldata name,
        string calldata symbol,
        uint256 cap,
        uint256 initialMint,
        address mintTo,
        bytes32 salt
    ) external returns (address token) {
        token = _finalize(
            Clones.cloneDeterministic(implementation, salt),
            name,
            symbol,
            cap,
            initialMint,
            mintTo,
            salt
        );
    }

    /// @notice Counterfactual address of the clone {createTokenDeterministic} would deploy for `salt`.
    function predictAddress(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @dev Initialize the freshly-cloned token, optionally mint, hand over roles, register, and
    ///      (if wired) publish verification metadata — all atomically in the cloning tx.
    function _finalize(
        address tokenAddr,
        string calldata name,
        string calldata symbol,
        uint256 cap,
        uint256 initialMint,
        address mintTo,
        bytes32 salt
    ) internal returns (address token) {
        token = tokenAddr;
        if (cap != 0 && initialMint > cap) revert CapBelowInitialMint(cap, initialMint);

        ERC20Initializable t = ERC20Initializable(token);
        // Factory is initial admin so it can mint, then hand over.
        t.initialize(name, symbol, cap, address(this));

        if (initialMint > 0) {
            if (mintTo == address(0)) revert MintToZero();
            t.mint(mintTo, initialMint);
        }

        // Scoped block: frees the three role slots before the metadata call below
        // (keeps the function under the 16-slot stack limit without via-ir).
        {
            bytes32 ADMIN = t.DEFAULT_ADMIN_ROLE();
            bytes32 MINTER = t.MINTER_ROLE();
            bytes32 PAUSER = t.PAUSER_ROLE();

            t.grantRole(ADMIN, msg.sender);
            t.grantRole(MINTER, msg.sender);
            t.grantRole(PAUSER, msg.sender);
            t.renounceRole(MINTER, address(this));
            t.renounceRole(PAUSER, address(this));
            t.renounceRole(ADMIN, address(this));
        }

        allTokens.push(token);
        creatorOf[token] = msg.sender;
        emit CloneCreated(token, msg.sender, name, symbol, cap, salt);

        // Explorer verification metadata (constructor args here = the initialize() args, since
        // clones have no constructor; off-chain tooling verifies against the impl's sourceId).
        if (address(metadataEmitter) != address(0)) {
            metadataEmitter.recordDeployment(
                token,
                sourceId,
                abi.encode(name, symbol, cap, msg.sender)
            );
        }
    }
}
