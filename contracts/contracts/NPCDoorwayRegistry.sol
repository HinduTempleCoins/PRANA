// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice View surface of MutableStatNFT used to read a single mutable stat by key.
interface IStatSource {
    function getStat(uint256 tokenId, bytes32 key) external view returns (uint256);
}

/// @notice View surface of MonumentFragmentRegistry used to read lore-reveal state.
interface IRevealSource {
    function revealed(address player, uint256 setId) external view returns (bool);
}

/// @title NPCDoorwayRegistry — composite gating for narrative doorways
/// @notice A doorway (bytes32 id) carries an ordered list of Requirements; {checkPassage}
///         returns true only when an account satisfies ALL of them (logical AND). Requirement
///         kinds knit together the suite's other primitives:
///           - OWNS_NFT     : IERC721(target).balanceOf(account) >= minValue (>=1 = owns any)
///           - MIN_STAT     : MutableStatNFT(target).getStat(tokenIdHint, idOrKey) >= minValue
///           - HOLDS_TOKEN  : IERC20(target).balanceOf(account) >= minValue
///           - REVEALED_SET : MonumentFragmentRegistry(target).revealed(account, uint(idOrKey))
///         A `hidden` flag lets a doorway exist while emitting no discovery metadata until a
///         later scout-discovery step flips it — gating still evaluates normally either way.
/// @dev ADMIN_ROLE manages doorways. MIN_STAT uses the caller-supplied `tokenIdHint` as the
///      stat-bearing token; the front-end passes the account's relevant token id.
contract NPCDoorwayRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    enum Kind {
        OWNS_NFT, // 0
        MIN_STAT, // 1
        HOLDS_TOKEN, // 2
        REVEALED_SET // 3
    }

    /// @param kind     Which check to apply.
    /// @param target   Contract the check is evaluated against.
    /// @param idOrKey  MIN_STAT: the stat key. REVEALED_SET: the setId (as bytes32). Else ignored.
    /// @param minValue Threshold for OWNS_NFT / MIN_STAT / HOLDS_TOKEN. Ignored for REVEALED_SET.
    struct Requirement {
        Kind kind;
        address target;
        bytes32 idOrKey;
        uint256 minValue;
    }

    /// @dev doorwayId => ordered requirements (ALL must pass).
    mapping(bytes32 => Requirement[]) private _reqs;
    /// @dev doorwayId => whether it has been defined.
    mapping(bytes32 => bool) private _exists;
    /// @dev doorwayId => hidden flag (no discovery metadata surfaced while true).
    mapping(bytes32 => bool) private _hidden;

    event DoorwaySet(bytes32 indexed doorwayId, uint256 count, bool hidden);
    event DoorwayRevealedFlag(bytes32 indexed doorwayId, bool hidden);
    event DoorwayCleared(bytes32 indexed doorwayId);

    error EmptyRequirements();
    error ZeroTarget(uint256 index);
    error UnknownDoorway(bytes32 doorwayId);

    /// @param admin Receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroTarget(0);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                               admin                                  //
    // --------------------------------------------------------------------- //

    /// @notice Define or replace the requirement set for `doorwayId`, with a hidden flag.
    /// @dev Reverts on an empty set (use {clearDoorway} to remove a doorway).
    function setDoorway(bytes32 doorwayId, Requirement[] calldata reqs, bool hidden_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (reqs.length == 0) revert EmptyRequirements();

        delete _reqs[doorwayId];
        Requirement[] storage dst = _reqs[doorwayId];
        for (uint256 i = 0; i < reqs.length; i++) {
            if (reqs[i].target == address(0)) revert ZeroTarget(i);
            dst.push(reqs[i]);
        }
        _exists[doorwayId] = true;
        _hidden[doorwayId] = hidden_;
        emit DoorwaySet(doorwayId, reqs.length, hidden_);
    }

    /// @notice Flip the hidden flag of an existing doorway (e.g. once it is discovered).
    function setHidden(bytes32 doorwayId, bool hidden_) external onlyRole(ADMIN_ROLE) {
        if (!_exists[doorwayId]) revert UnknownDoorway(doorwayId);
        _hidden[doorwayId] = hidden_;
        emit DoorwayRevealedFlag(doorwayId, hidden_);
    }

    /// @notice Remove `doorwayId` entirely. After this {checkPassage} returns false.
    function clearDoorway(bytes32 doorwayId) external onlyRole(ADMIN_ROLE) {
        if (!_exists[doorwayId]) revert UnknownDoorway(doorwayId);
        delete _reqs[doorwayId];
        delete _exists[doorwayId];
        delete _hidden[doorwayId];
        emit DoorwayCleared(doorwayId);
    }

    // --------------------------------------------------------------------- //
    //                                reads                                  //
    // --------------------------------------------------------------------- //

    /// @notice Whether `doorwayId` is defined.
    function doorwayExists(bytes32 doorwayId) external view returns (bool) {
        return _exists[doorwayId];
    }

    /// @notice Whether `doorwayId` is hidden (no discovery metadata surfaced).
    function isHidden(bytes32 doorwayId) external view returns (bool) {
        return _hidden[doorwayId];
    }

    /// @notice Number of requirements configured for `doorwayId`.
    function requirementCount(bytes32 doorwayId) external view returns (uint256) {
        return _reqs[doorwayId].length;
    }

    /// @notice Read a single requirement by index.
    function requirementAt(bytes32 doorwayId, uint256 index)
        external
        view
        returns (Requirement memory)
    {
        return _reqs[doorwayId][index];
    }

    /// @notice True if `account` satisfies EVERY requirement of `doorwayId`.
    /// @dev Returns false for an undefined doorway. `tokenIdHint` is the stat-bearing token id
    ///      used by any MIN_STAT requirement; it is ignored by the other kinds.
    function checkPassage(bytes32 doorwayId, address account, uint256 tokenIdHint)
        external
        view
        returns (bool)
    {
        if (!_exists[doorwayId]) return false;
        Requirement[] storage reqs = _reqs[doorwayId];
        for (uint256 i = 0; i < reqs.length; i++) {
            if (!_meets(reqs[i], account, tokenIdHint)) return false;
        }
        return true;
    }

    // --------------------------------------------------------------------- //
    //                              internal                                //
    // --------------------------------------------------------------------- //

    /// @dev Evaluate one requirement. External calls are wrapped so a misbehaving target
    ///      fails the requirement cleanly rather than reverting the whole view.
    function _meets(Requirement storage r, address account, uint256 tokenIdHint)
        internal
        view
        returns (bool)
    {
        if (r.kind == Kind.OWNS_NFT) {
            try IERC721(r.target).balanceOf(account) returns (uint256 bal) {
                return bal >= r.minValue;
            } catch {
                return false;
            }
        }
        if (r.kind == Kind.HOLDS_TOKEN) {
            try IERC20(r.target).balanceOf(account) returns (uint256 bal) {
                return bal >= r.minValue;
            } catch {
                return false;
            }
        }
        if (r.kind == Kind.MIN_STAT) {
            try IStatSource(r.target).getStat(tokenIdHint, r.idOrKey) returns (uint256 v) {
                return v >= r.minValue;
            } catch {
                return false;
            }
        }
        // Kind.REVEALED_SET: account must have revealed set uint256(idOrKey).
        try IRevealSource(r.target).revealed(account, uint256(r.idOrKey)) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
