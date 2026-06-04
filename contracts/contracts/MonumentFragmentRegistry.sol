// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal view surface of a soulbound ERC-721 (e.g. SoulboundToken.sol) used to
///         verify fragment ownership. Each fragment is a specific, non-transferable tokenId.
interface IFragmentToken {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title MonumentFragmentRegistry — assemble a fragment set to reveal a lore segment
/// @notice Admins define sets, each pinned to a soulbound fragment token contract and a list
///         of required fragment token-ids. A player who holds EVERY fragment in a set may call
///         {claimReveal} to permanently unlock that set's `contentRef` (a bytes32 the
///         front-end resolves to the corresponding segment of the lore corpus / chronicle).
///         Reveals are recorded per (player, set); the first revealer of each set is recorded
///         and a running reveal count is kept. A set is immutable once {sealSet} is called.
/// @dev Fragments live on an external soulbound ERC-721 (SoulboundToken), so a fragment can
///      neither be traded into a wallet nor duplicated — owning all of them is real progress.
contract MonumentFragmentRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @param token       Soulbound fragment token contract holding the required fragments.
    /// @param fragmentIds Token-ids on `token` that must ALL be held to reveal.
    /// @param contentRef  Opaque reference (bytes32) the front-end maps to the lore segment.
    /// @param sealed_     Once true the set is frozen and can never be edited.
    struct FragmentSet {
        address token;
        uint256[] fragmentIds;
        bytes32 contentRef;
        bool sealed_;
    }

    /// @dev setId => set definition.
    mapping(uint256 => FragmentSet) private _sets;
    /// @dev setId => whether it has been created.
    mapping(uint256 => bool) private _exists;
    /// @dev player => setId => revealed.
    mapping(address => mapping(uint256 => bool)) public revealed;
    /// @dev setId => total reveals.
    mapping(uint256 => uint256) public revealCount;
    /// @dev setId => first account to reveal (address(0) until first reveal).
    mapping(uint256 => address) public firstRevealer;

    event SetDefined(uint256 indexed setId, address indexed token, uint256 fragmentCount, bytes32 contentRef);
    event SetSealed(uint256 indexed setId);
    event CorpusRevealed(address indexed player, uint256 indexed setId, bytes32 contentRef);

    error SetExists(uint256 setId);
    error UnknownSet(uint256 setId);
    error SetIsSealed(uint256 setId);
    error EmptyFragments();
    error ZeroToken();
    error AlreadyRevealed(uint256 setId);
    error FragmentNotHeld(uint256 fragmentId);

    /// @param admin Receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroToken();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------- //
    //                               admin                                  //
    // --------------------------------------------------------------------- //

    /// @notice Define a brand-new (unsealed) fragment set.
    /// @dev Reverts if `setId` already exists. The set may be edited until {sealSet}.
    function defineSet(
        uint256 setId,
        address token,
        uint256[] calldata fragmentIds,
        bytes32 contentRef
    ) external onlyRole(ADMIN_ROLE) {
        if (_exists[setId]) revert SetExists(setId);
        if (token == address(0)) revert ZeroToken();
        if (fragmentIds.length == 0) revert EmptyFragments();

        _exists[setId] = true;
        FragmentSet storage s = _sets[setId];
        s.token = token;
        s.contentRef = contentRef;
        for (uint256 i = 0; i < fragmentIds.length; i++) {
            s.fragmentIds.push(fragmentIds[i]);
        }
        emit SetDefined(setId, token, fragmentIds.length, contentRef);
    }

    /// @notice Repoint the `contentRef` of an existing, not-yet-sealed set.
    function setContentRef(uint256 setId, bytes32 contentRef) external onlyRole(ADMIN_ROLE) {
        FragmentSet storage s = _requireUnsealed(setId);
        s.contentRef = contentRef;
        emit SetDefined(setId, s.token, s.fragmentIds.length, contentRef);
    }

    /// @notice Seal `setId`, freezing its token, fragments and contentRef forever.
    function sealSet(uint256 setId) external onlyRole(ADMIN_ROLE) {
        FragmentSet storage s = _requireUnsealed(setId);
        s.sealed_ = true;
        emit SetSealed(setId);
    }

    // --------------------------------------------------------------------- //
    //                               reveal                                 //
    // --------------------------------------------------------------------- //

    /// @notice Reveal `setId` for the caller, requiring the caller to hold ALL fragments.
    /// @dev Reverts if already revealed by the caller or if any fragment is not held. Marks
    ///      the reveal, records the first revealer, bumps the count and emits CorpusRevealed.
    function claimReveal(uint256 setId) external {
        if (!_exists[setId]) revert UnknownSet(setId);
        if (revealed[msg.sender][setId]) revert AlreadyRevealed(setId);

        FragmentSet storage s = _sets[setId];
        _requireHoldsAll(s.token, s.fragmentIds, msg.sender);

        revealed[msg.sender][setId] = true;
        if (revealCount[setId] == 0) {
            firstRevealer[setId] = msg.sender;
        }
        revealCount[setId] += 1;
        emit CorpusRevealed(msg.sender, setId, s.contentRef);
    }

    /// @notice True if `account` currently holds every fragment of `setId` (ignores prior reveal).
    function canReveal(uint256 setId, address account) external view returns (bool) {
        if (!_exists[setId]) return false;
        FragmentSet storage s = _sets[setId];
        uint256[] storage ids = s.fragmentIds;
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_holds(s.token, ids[i], account)) return false;
        }
        return true;
    }

    // --------------------------------------------------------------------- //
    //                                reads                                  //
    // --------------------------------------------------------------------- //

    /// @notice Whether `setId` has been defined.
    function setExists(uint256 setId) external view returns (bool) {
        return _exists[setId];
    }

    /// @notice Whether `setId` is sealed (immutable).
    function isSealed(uint256 setId) external view returns (bool) {
        return _sets[setId].sealed_;
    }

    /// @notice Full definition of `setId`.
    function getSet(uint256 setId)
        external
        view
        returns (address token, uint256[] memory fragmentIds, bytes32 contentRef, bool sealed_)
    {
        if (!_exists[setId]) revert UnknownSet(setId);
        FragmentSet storage s = _sets[setId];
        return (s.token, s.fragmentIds, s.contentRef, s.sealed_);
    }

    /// @notice The required fragment token-ids of `setId`.
    function fragmentsOf(uint256 setId) external view returns (uint256[] memory) {
        if (!_exists[setId]) revert UnknownSet(setId);
        return _sets[setId].fragmentIds;
    }

    // --------------------------------------------------------------------- //
    //                              internal                                //
    // --------------------------------------------------------------------- //

    function _requireUnsealed(uint256 setId) private view returns (FragmentSet storage s) {
        if (!_exists[setId]) revert UnknownSet(setId);
        s = _sets[setId];
        if (s.sealed_) revert SetIsSealed(setId);
    }

    function _requireHoldsAll(address token, uint256[] storage ids, address account) private view {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (!_holds(token, id, account)) revert FragmentNotHeld(id);
        }
    }

    /// @dev try/catch so a burned/nonexistent fragment (ownerOf reverts) cleanly reads as
    ///      "not held" instead of bubbling up a revert.
    function _holds(address token, uint256 id, address account) private view returns (bool) {
        try IFragmentToken(token).ownerOf(id) returns (address owner) {
            return owner == account;
        } catch {
            return false;
        }
    }
}
