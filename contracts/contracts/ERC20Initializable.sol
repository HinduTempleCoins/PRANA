// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ERC20Initializable — a clone-ready (EIP-1167) ERC-20 template
/// @notice Functionally equivalent to {ERC20Base} (mintable/role-gated, burnable, hard-capped,
///         pausable, EIP-2612 permit) but built to be deployed as a minimal-proxy clone.
///
/// @dev WHY NOT JUST CLONE ERC20Base?
///      Clones run the implementation's *runtime* via DELEGATECALL but never run its
///      constructor in the clone's context. OZ's `ERC20` stores name/symbol fine (they are
///      plain storage), BUT:
///        - OZ `ERC20Capped` / role grants happen in the constructor → would never run for a clone.
///        - OZ `ERC20Permit` (EIP712) caches the domain separator + hashed name in *immutables*
///          computed from the IMPLEMENTATION's address at impl-deploy time. Every clone would
///          then sign/verify against the wrong domain (wrong `verifyingContract`, wrong name).
///      So this contract hand-rolls everything that must be per-clone state:
///        - `_name`/`_symbol`/`_cap` are storage set in {initialize}, not constructor.
///        - The EIP-712 domain separator is rebuilt ON DEMAND from storage + `address(this)`
///          (the clone's own address) every time it is needed, so permit is CORRECT per clone.
///          (We accept the small gas cost of recomputing the separator rather than caching an
///          immutable that clones cannot have.)
///      The implementation contract self-bricks in its constructor (`initialized = true`) so the
///      bare implementation can never be initialized or used directly.
contract ERC20Initializable is IERC20, IERC20Metadata, IERC20Errors, IERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // --- EIP-712 / EIP-2612 type hashes ---
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant VERSION_HASH = keccak256(bytes("1"));

    // --- token storage (all per-clone; set in initialize) ---
    string private _name;
    string private _symbol;
    uint256 private _cap; // 0 = uncapped
    bool private _paused;
    bool public initialized;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    mapping(address => uint256) private _nonces;

    event Paused(address account);
    event Unpaused(address account);

    error AlreadyInitialized();
    error NotInitialized();
    error AdminIsZero();
    error CapExceeded(uint256 cap, uint256 attempted);
    error EnforcedPause();
    error PermitExpired();
    error InvalidPermitSignature();

    /// @dev Brick the implementation: a deployed implementation must never be usable directly,
    ///      and must never be initializable by a griefer. Clones skip constructors, so their
    ///      `initialized` stays false until {initialize} flips it.
    constructor() {
        initialized = true;
    }

    /// @notice One-time initializer, called by the factory atomically right after cloning.
    /// @param cap_ hard supply cap; pass 0 for effectively uncapped.
    function initialize(string memory name_, string memory symbol_, uint256 cap_, address admin) external {
        if (initialized) revert AlreadyInitialized();
        if (admin == address(0)) revert AdminIsZero();
        initialized = true;

        _name = name_;
        _symbol = symbol_;
        _cap = cap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    modifier whenInitialized() {
        if (!initialized) revert NotInitialized();
        _;
    }

    // ---------------------------------------------------------------------
    // Metadata
    // ---------------------------------------------------------------------
    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function decimals() public pure returns (uint8) {
        return 18;
    }

    function cap() public view returns (uint256) {
        return _cap;
    }

    function paused() public view returns (bool) {
        return _paused;
    }

    // ---------------------------------------------------------------------
    // ERC-20 core
    // ---------------------------------------------------------------------
    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value);
        return true;
    }

    /// @notice Burn caller's tokens (ERC20Burnable parity).
    function burn(uint256 value) external {
        _update(msg.sender, address(0), value);
    }

    /// @notice Burn from `account` using caller's allowance (ERC20Burnable parity).
    function burnFrom(address account, uint256 value) external {
        _spendAllowance(account, msg.sender, value);
        _update(account, address(0), value);
    }

    // ---------------------------------------------------------------------
    // Mint / pause (role-gated)
    // ---------------------------------------------------------------------
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _update(address(0), to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Internal ledger (mirrors OZ ERC20 + Capped + Pausable in one _update)
    // ---------------------------------------------------------------------
    function _transfer(address from, address to, uint256 value) internal {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        _update(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal {
        if (_paused) revert EnforcedPause();

        if (from == address(0)) {
            // mint: enforce cap (0 = uncapped)
            uint256 cap_ = _cap;
            if (cap_ != 0) {
                uint256 newSupply = _totalSupply + value;
                if (newSupply > cap_) revert CapExceeded(cap_, newSupply);
            }
            _totalSupply += value;
        } else {
            uint256 fromBal = _balances[from];
            if (fromBal < value) revert ERC20InsufficientBalance(from, fromBal, value);
            unchecked {
                _balances[from] = fromBal - value;
            }
        }

        if (to == address(0)) {
            unchecked {
                _totalSupply -= value;
            }
        } else {
            unchecked {
                _balances[to] += value;
            }
        }

        emit Transfer(from, to, value);
    }

    function _approve(address owner, address spender, uint256 value) internal {
        if (owner == address(0)) revert ERC20InvalidApprover(address(0));
        if (spender == address(0)) revert ERC20InvalidSpender(address(0));
        _allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 current = _allowances[owner][spender];
        if (current != type(uint256).max) {
            if (current < value) revert ERC20InsufficientAllowance(spender, current, value);
            unchecked {
                _approve(owner, spender, current - value);
            }
        }
    }

    // ---------------------------------------------------------------------
    // EIP-2612 permit — domain separator built lazily from storage (clone-safe)
    // ---------------------------------------------------------------------
    function nonces(address owner) public view returns (uint256) {
        return _nonces[owner];
    }

    /// @dev Rebuilt on demand from per-clone storage + this clone's own address. NOT cached in
    ///      an immutable (clones can't carry per-instance immutables), so every clone produces
    ///      the correct, distinct domain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256(bytes(_name)),
                    VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenInitialized {
        if (block.timestamp > deadline) revert PermitExpired();

        uint256 nonce = _nonces[owner];
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));

        address signer = ECDSA.recover(digest, v, r, s);
        if (signer != owner || owner == address(0)) revert InvalidPermitSignature();

        unchecked {
            _nonces[owner] = nonce + 1;
        }
        _approve(owner, spender, value);
    }
}
