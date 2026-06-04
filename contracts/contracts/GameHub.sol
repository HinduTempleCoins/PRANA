// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title GameHub
/// @notice On-chain service-discovery registry for a game suite. Maps short, human-readable
///         keys (e.g. "creatures", "farm", "market", "crafting") to a deployed contract
///         address plus a monotonically increasing version number. A front-end can be
///         configured with a single hub address and enumerate the entire suite via
///         {getAll}, so module upgrades require no client redeploys.
/// @dev Keys are bytes32 (use `ethers.encodeBytes32String("farm")` off-chain). The set of
///      registered keys is tracked with an EnumerableSet so it is fully enumerable on-chain.
contract GameHub is AccessControl {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Module {
        address addr;
        uint64 version;
    }

    /// @dev key => current module record.
    mapping(bytes32 => Module) private _modules;

    /// @dev Enumerable set of all registered keys.
    EnumerableSet.Bytes32Set private _keys;

    /// @notice Emitted the first time a key is registered.
    event ModuleRegistered(bytes32 indexed key, address indexed addr, uint64 version);
    /// @notice Emitted when an already-registered key is pointed at a new address.
    event ModuleUpdated(bytes32 indexed key, address indexed addr, uint64 version);
    /// @notice Emitted when a key is removed from the registry.
    event ModuleRemoved(bytes32 indexed key);

    error ZeroKey();
    error ZeroAddress();
    error AlreadyRegistered(bytes32 key);
    error NotRegistered(bytes32 key);

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /// @notice Register a brand-new module under `key` at version 1.
    /// @dev Reverts if `key` already exists; use {updateModule} to repoint it.
    function registerModule(bytes32 key, address addr) external onlyRole(ADMIN_ROLE) {
        if (key == bytes32(0)) revert ZeroKey();
        if (addr == address(0)) revert ZeroAddress();
        if (_keys.contains(key)) revert AlreadyRegistered(key);

        _keys.add(key);
        _modules[key] = Module({addr: addr, version: 1});
        emit ModuleRegistered(key, addr, 1);
    }

    /// @notice Point an existing `key` at a new address, bumping its version.
    /// @dev Reverts if `key` is not yet registered; use {registerModule} first.
    function updateModule(bytes32 key, address addr) external onlyRole(ADMIN_ROLE) {
        if (addr == address(0)) revert ZeroAddress();
        if (!_keys.contains(key)) revert NotRegistered(key);

        Module storage m = _modules[key];
        m.addr = addr;
        m.version += 1;
        emit ModuleUpdated(key, addr, m.version);
    }

    /// @notice Remove `key` from the registry entirely.
    function removeModule(bytes32 key) external onlyRole(ADMIN_ROLE) {
        if (!_keys.contains(key)) revert NotRegistered(key);
        _keys.remove(key);
        delete _modules[key];
        emit ModuleRemoved(key);
    }

    /// @notice Current address registered under `key` (address(0) if none).
    function get(bytes32 key) external view returns (address) {
        return _modules[key].addr;
    }

    /// @notice Full module record (address + version) for `key`.
    function getModule(bytes32 key) external view returns (address addr, uint64 version) {
        Module storage m = _modules[key];
        return (m.addr, m.version);
    }

    /// @notice Whether `key` is currently registered.
    function exists(bytes32 key) external view returns (bool) {
        return _keys.contains(key);
    }

    /// @notice Number of registered modules.
    function count() external view returns (uint256) {
        return _keys.length();
    }

    /// @notice The registered key at enumeration index `index`.
    function keyAt(uint256 index) external view returns (bytes32) {
        return _keys.at(index);
    }

    /// @notice Every registered key.
    function allKeys() external view returns (bytes32[] memory) {
        return _keys.values();
    }

    /// @notice Enumerate the whole suite: parallel arrays of keys, addresses and versions.
    /// @dev Lets a front-end discover every module from one call.
    function getAll()
        external
        view
        returns (bytes32[] memory keys, address[] memory addrs, uint64[] memory versions)
    {
        uint256 len = _keys.length();
        keys = new bytes32[](len);
        addrs = new address[](len);
        versions = new uint64[](len);
        for (uint256 i = 0; i < len; i++) {
            bytes32 k = _keys.at(i);
            Module storage m = _modules[k];
            keys[i] = k;
            addrs[i] = m.addr;
            versions[i] = m.version;
        }
    }
}
