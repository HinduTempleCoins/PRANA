// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RoyaltyNFT} from "./RoyaltyNFT.sol";

/// @title NFTFactoryWizard — the deploy-wizard core for NFT collections: one call → a live, owned
///        ERC-721 with EIP-2981 royalties
/// @notice Mirror of {ERC20FactoryWizard} for {RoyaltyNFT}. Deploys a role-gated mintable ERC-721,
///         hands ALL roles to the creator and renounces the factory's own roles — so the factory is
///         never a backdoor. Emits a registry event an explorer can index/verify.
contract NFTFactoryWizard {
    address[] public allCollections;
    mapping(address => address) public creatorOf;

    event CollectionCreated(
        address indexed collection,
        address indexed creator,
        string name,
        string symbol,
        address royaltyReceiver,
        uint96 feeBps
    );

    error ZeroRoyaltyReceiver();
    error FeeTooHigh(uint96 feeBps);

    /// @notice Deploy a {RoyaltyNFT}, grant admin+minter to the caller, and renounce the factory's
    ///         own roles. The factory is the initial admin only so it can hand over authority.
    /// @param name Collection name.
    /// @param symbol Collection symbol.
    /// @param royaltyReceiver Default EIP-2981 royalty receiver (must be non-zero).
    /// @param feeBps Default royalty fee in basis points (capped at 10000 = 100%).
    /// @return collection Address of the newly deployed collection.
    function createCollection(
        string calldata name,
        string calldata symbol,
        address royaltyReceiver,
        uint96 feeBps
    ) external returns (address collection) {
        if (royaltyReceiver == address(0)) revert ZeroRoyaltyReceiver();
        if (feeBps > 10000) revert FeeTooHigh(feeBps);

        // factory is the initial admin so it can hand over roles, then drop its own authority
        RoyaltyNFT c = new RoyaltyNFT(name, symbol, address(this), royaltyReceiver, feeBps);

        bytes32 ADMIN = c.DEFAULT_ADMIN_ROLE();
        bytes32 MINTER = c.MINTER_ROLE();

        // grant everything to the creator, then drop the factory's own roles (no backdoor)
        c.grantRole(ADMIN, msg.sender);
        c.grantRole(MINTER, msg.sender);
        c.renounceRole(MINTER, address(this));
        c.renounceRole(ADMIN, address(this));

        collection = address(c);
        allCollections.push(collection);
        creatorOf[collection] = msg.sender;
        emit CollectionCreated(collection, msg.sender, name, symbol, royaltyReceiver, feeBps);
    }

    function collectionCount() external view returns (uint256) {
        return allCollections.length;
    }
}
