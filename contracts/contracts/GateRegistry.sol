// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @notice Minimal view surface of SubscriptionLockNFT needed to evaluate a time-bound key.
///         A key grants access while owned by the account AND not yet expired.
interface ISubscriptionLockNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function expiryOf(uint256 tokenId) external view returns (uint64);
}

/// @title GateRegistry — on-chain readable token-gating rules for rooms / logins
/// @notice Maps a room id to a list of access Requirements. `checkAccess` returns true only
///         when an account satisfies ALL requirements (logical AND). Rules are managed by
///         ADMIN_ROLE. Rooms are opaque bytes32 ids (e.g. a hash of a room slug). A gate bot
///         or client reads `checkAccess` to decide whether to admit an account.
///
///         Supported requirement kinds:
///           - ERC20            : balanceOf(account) >= minBalance
///           - ERC721           : balanceOf(account) >= minBalance (>=1 = "owns any")
///           - ERC1155          : balanceOf(account, idOrMin) >= minBalance for a specific id
///           - SubscriptionKey  : account owns SubscriptionLockNFT token `idOrMin` and it is
///                                unexpired (time-bound key check, per SubscriptionLockNFT.sol)
contract GateRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev Kind of asset a Requirement checks.
    enum Kind {
        ERC20, // 0
        ERC721, // 1
        ERC1155, // 2
        SubscriptionKey // 3
    }

    /// @param token      Contract address of the gating asset.
    /// @param kind       Which token standard / check to apply.
    /// @param idOrMin    For ERC1155: the token id. For SubscriptionKey: the key (NFT) id.
    ///                   Ignored for ERC20/ERC721.
    /// @param minBalance Minimum balance required (ERC20/ERC721/ERC1155). For SubscriptionKey
    ///                   it is ignored (the check is ownership + unexpired).
    struct Requirement {
        address token;
        Kind kind;
        uint256 idOrMin;
        uint256 minBalance;
    }

    /// @dev roomId => ordered list of requirements (ALL must pass).
    mapping(bytes32 => Requirement[]) private _rules;

    event RuleSet(bytes32 indexed roomId, uint256 count);
    event RuleCleared(bytes32 indexed roomId);

    error EmptyRequirements();
    error ZeroToken(uint256 index);
    error BadMinBalance(uint256 index);

    /// @param admin Receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                               admin                                   //
    // --------------------------------------------------------------------- //

    /// @notice Replace the full requirement set for `roomId`. Overwrites any prior rules.
    /// @dev Reverts on an empty set (use {clearRule} to open a room). Validates each entry.
    function setRule(bytes32 roomId, Requirement[] calldata reqs)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (reqs.length == 0) revert EmptyRequirements();

        delete _rules[roomId];
        Requirement[] storage dst = _rules[roomId];

        for (uint256 i = 0; i < reqs.length; i++) {
            Requirement calldata r = reqs[i];
            if (r.token == address(0)) revert ZeroToken(i);
            // ERC20/721/1155 must demand at least 1 unit; SubscriptionKey ignores minBalance.
            if (r.kind != Kind.SubscriptionKey && r.minBalance == 0) {
                revert BadMinBalance(i);
            }
            dst.push(r);
        }

        emit RuleSet(roomId, reqs.length);
    }

    /// @notice Remove all requirements for `roomId`. After this {checkAccess} returns false
    ///         (a room with no rules is treated as "no one is admitted by the gate").
    function clearRule(bytes32 roomId) external onlyRole(ADMIN_ROLE) {
        delete _rules[roomId];
        emit RuleCleared(roomId);
    }

    // --------------------------------------------------------------------- //
    //                               reads                                   //
    // --------------------------------------------------------------------- //

    /// @notice Number of requirements configured for `roomId`.
    function requirementCount(bytes32 roomId) external view returns (uint256) {
        return _rules[roomId].length;
    }

    /// @notice Read a single requirement by index.
    function requirementAt(bytes32 roomId, uint256 index)
        external
        view
        returns (Requirement memory)
    {
        return _rules[roomId][index];
    }

    /// @notice Read the full requirement set for `roomId`.
    function requirements(bytes32 roomId)
        external
        view
        returns (Requirement[] memory)
    {
        return _rules[roomId];
    }

    /// @notice True if `account` satisfies EVERY requirement of `roomId`.
    /// @dev Returns false for a room with no configured rules. The SubscriptionKey check is
    ///      wrapped in try/catch so a burned/nonexistent key fails cleanly; ERC20/721/1155
    ///      calls are trusted to be well-formed standard token contracts.
    function checkAccess(bytes32 roomId, address account)
        external
        view
        returns (bool)
    {
        Requirement[] storage reqs = _rules[roomId];
        uint256 n = reqs.length;
        if (n == 0) return false;

        for (uint256 i = 0; i < n; i++) {
            if (!_meets(reqs[i], account)) return false;
        }
        return true;
    }

    /// @dev Evaluate a single requirement for `account`.
    function _meets(Requirement storage r, address account)
        internal
        view
        returns (bool)
    {
        if (r.kind == Kind.ERC20) {
            return IERC20(r.token).balanceOf(account) >= r.minBalance;
        }
        if (r.kind == Kind.ERC721) {
            return IERC721(r.token).balanceOf(account) >= r.minBalance;
        }
        if (r.kind == Kind.ERC1155) {
            return IERC1155(r.token).balanceOf(account, r.idOrMin) >= r.minBalance;
        }
        // Kind.SubscriptionKey: time-bound NFT membership key (SubscriptionLockNFT).
        // Account must currently own the key `idOrMin` AND the key must be unexpired.
        return _meetsSubscription(r.token, r.idOrMin, account);
    }

    /// @dev Ownership + unexpired check for a SubscriptionLockNFT key. Uses a try/catch so a
    ///      burned/nonexistent token (ownerOf reverts) cleanly fails the requirement instead
    ///      of reverting the whole view.
    function _meetsSubscription(address token, uint256 keyId, address account)
        internal
        view
        returns (bool)
    {
        try ISubscriptionLockNFT(token).ownerOf(keyId) returns (address owner) {
            if (owner != account) return false;
            uint64 expiry = ISubscriptionLockNFT(token).expiryOf(keyId);
            return expiry > block.timestamp;
        } catch {
            return false;
        }
    }
}
