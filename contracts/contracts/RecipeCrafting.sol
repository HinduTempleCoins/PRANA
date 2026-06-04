// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title RecipeCrafting
/// @notice A "recipe web" crafting sink for an ERC-1155 game-item economy.
///         An admin registers recipes mapping input items -> an output item.
///         A player crafts by burning the input amounts from their own balance;
///         the output is freshly minted to them (consumables = self-draining sink).
/// @dev    This contract must hold MINTER_ROLE on the items collection so it can
///         mint outputs. Inputs are burned via the items contract's burn(), which
///         requires the crafter to have approved this contract as an operator.
interface IItemsToken is IERC1155 {
    function mint(address to, uint256 id, uint256 amount, bytes memory data) external;

    function burn(address from, uint256 id, uint256 amount) external;
}

contract RecipeCrafting is AccessControl, ERC1155Holder {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Recipe {
        uint256[] inputIds;
        uint256[] inputAmounts;
        uint256 outputId;
        uint256 outputAmount;
        bool exists;
    }

    /// @notice The single items collection used for both inputs and outputs.
    IItemsToken public immutable items;

    /// @notice recipeId => Recipe.
    mapping(uint256 => Recipe) private _recipes;

    /// @notice Number of recipes registered (also the next recipeId).
    uint256 public recipeCount;

    event RecipeAdded(
        uint256 indexed recipeId,
        uint256[] inputIds,
        uint256[] inputAmounts,
        uint256 outputId,
        uint256 outputAmount
    );
    event Crafted(uint256 indexed recipeId, address indexed crafter);

    error LengthMismatch();
    error EmptyInputs();
    error ZeroOutputAmount();
    error UnknownRecipe(uint256 recipeId);

    constructor(address itemsToken, address admin) {
        items = IItemsToken(itemsToken);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /// @notice Register a new recipe. Returns its recipeId.
    function addRecipe(
        uint256[] calldata inputIds,
        uint256[] calldata inputAmounts,
        uint256 outputId,
        uint256 outputAmount
    ) external onlyRole(ADMIN_ROLE) returns (uint256 recipeId) {
        if (inputIds.length != inputAmounts.length) revert LengthMismatch();
        if (inputIds.length == 0) revert EmptyInputs();
        if (outputAmount == 0) revert ZeroOutputAmount();

        recipeId = recipeCount++;
        Recipe storage r = _recipes[recipeId];
        r.inputIds = inputIds;
        r.inputAmounts = inputAmounts;
        r.outputId = outputId;
        r.outputAmount = outputAmount;
        r.exists = true;

        emit RecipeAdded(recipeId, inputIds, inputAmounts, outputId, outputAmount);
    }

    /// @notice Craft a registered recipe: burns the input amounts from the
    ///         caller's balance and mints the output to the caller.
    function craft(uint256 recipeId) external {
        Recipe storage r = _recipes[recipeId];
        if (!r.exists) revert UnknownRecipe(recipeId);

        uint256 len = r.inputIds.length;
        for (uint256 i = 0; i < len; ++i) {
            // Burns from the crafter; reverts if balance/approval insufficient.
            items.burn(msg.sender, r.inputIds[i], r.inputAmounts[i]);
        }

        items.mint(msg.sender, r.outputId, r.outputAmount, "");

        emit Crafted(recipeId, msg.sender);
    }

    /// @notice Read a registered recipe.
    function getRecipe(uint256 recipeId)
        external
        view
        returns (
            uint256[] memory inputIds,
            uint256[] memory inputAmounts,
            uint256 outputId,
            uint256 outputAmount
        )
    {
        Recipe storage r = _recipes[recipeId];
        if (!r.exists) revert UnknownRecipe(recipeId);
        return (r.inputIds, r.inputAmounts, r.outputId, r.outputAmount);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl, ERC1155Holder)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
