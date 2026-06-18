// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title REN — MELEK's on-chain name registrar ("DNS blockchain")
/// @notice The Egyptian *Ren* (a being's true name). Each REN name (e.g. "ryan.melek") is an ERC-721,
///         leased ANNUALLY like a domain registrar — pay in **PRANA** (native) or **KULA** (ERC-20),
///         length-tiered pricing, expiry + grace period. Owners point a name at records (an address, an
///         IPFS contenthash so a name can resolve to a SITE, and arbitrary text records). Resolution is
///         done by our own clients (Akasha wallet, Hathor, the bots) reading this contract over the PRANA
///         RPC — a sovereign namespace that needs neither ICANN/Web2 DNS nor any external Web3 resolver.
/// @dev    ENS-lite, collapsed into one auditable contract in the style of LandPortalRegistry: registrar
///         + resolver + records together. tokenId = uint256(keccak256(fullName)). Fees forward to a
///         `feeRecipient` (set to the Hathor floor / DAO / burn address). Pull nothing — fully push.
contract RENRegistrar is ERC721, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint256 public constant GRACE_PERIOD = 90 days; // after expiry, only the owner may renew; then it frees
    uint256 public constant MAX_YEARS = 10;

    IERC20 public kula;            // the KULA token (payment option B)
    address public feeRecipient;   // where PRANA + KULA fees go (Hathor floor / DAO / burn)

    // length tier (1,2,3,4,5+ chars of the LABEL) -> annual price. Index 0..4; idx = min(len,5)-1.
    uint256[5] public annualPrana; // wei of native PRANA / year
    uint256[5] public annualKula;  // wei of KULA / year

    struct Record {
        uint64 expires;     // unix seconds; lease end
        address addr;       // resolves-to address (the "A record")
        bytes32 contenthash;// IPFS/host content id (the "site")
    }
    mapping(uint256 => Record) private _rec;            // tokenId -> record
    mapping(uint256 => string) public nameOf;           // tokenId -> full name (for reverse display)
    mapping(uint256 => mapping(string => string)) private _text; // tokenId -> key -> value
    mapping(bytes32 => bool) public tldAllowed;         // keccak256(tld) -> allowed (e.g. "melek")

    event Registered(uint256 indexed id, string name, address indexed owner, uint64 expires, bool paidInKula, uint256 cost);
    event Renewed(uint256 indexed id, string name, uint64 expires, bool paidInKula, uint256 cost);
    event AddrSet(uint256 indexed id, address addr);
    event ContenthashSet(uint256 indexed id, bytes32 contenthash);
    event TextSet(uint256 indexed id, string key, string value);
    event TldSet(string tld, bool allowed);
    event PricesSet();

    constructor(address kula_, address feeRecipient_, address admin) ERC721("REN Name", "REN") {
        require(feeRecipient_ != address(0) && admin != address(0), "zero");
        kula = IERC20(kula_);
        feeRecipient = feeRecipient_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        // sensible default annual prices (admin can retune): short names cost more.
        annualPrana = [50 ether, 20 ether, 10 ether, 5 ether, 1 ether];
        annualKula  = [500 ether, 200 ether, 100 ether, 50 ether, 10 ether];
        tldAllowed[keccak256(bytes("melek"))] = true;
        tldAllowed[keccak256(bytes("prana"))] = true;
        tldAllowed[keccak256(bytes("kula"))] = true;
    }

    // ── views ───────────────────────────────────────────────────────────────────────────────────────
    function id(string memory name) public pure returns (uint256) { return uint256(keccak256(bytes(name))); }

    /// @notice A name is registerable if it was never registered, or expired AND past the grace period.
    function available(string memory name) public view returns (bool) {
        uint256 t = id(name);
        uint64 e = _rec[t].expires;
        return e == 0 || block.timestamp > uint256(e) + GRACE_PERIOD;
    }

    function nameExpires(string memory name) external view returns (uint64) { return _rec[id(name)].expires; }

    /// @notice Annual price for a name by its LABEL length (chars before the first dot), × years.
    function priceOf(string memory name, uint256 years_, bool inKula) public view returns (uint256) {
        require(years_ >= 1 && years_ <= MAX_YEARS, "years");
        uint256 idx = _tierIndex(name);
        return (inKula ? annualKula[idx] : annualPrana[idx]) * years_;
    }

    function resolve(string memory name) external view returns (address) {
        uint256 t = id(name);
        if (_rec[t].expires == 0 || block.timestamp > _rec[t].expires) return address(0); // expired = no resolve
        return _rec[t].addr;
    }
    function contenthashOf(string memory name) external view returns (bytes32) {
        uint256 t = id(name);
        if (block.timestamp > _rec[t].expires) return bytes32(0);
        return _rec[t].contenthash;
    }
    function text(string memory name, string memory key) external view returns (string memory) {
        uint256 t = id(name);
        if (block.timestamp > _rec[t].expires) return "";
        return _text[t][key];
    }

    // ── register / renew (pay in PRANA via msg.value, or KULA via approve+transferFrom) ───────────────
    /// @param name   full name incl. allowlisted TLD, e.g. "ryan.melek" (lowercased a-z0-9- label).
    /// @param years_ lease length in years (1..10).
    /// @param inKula true → pay in KULA (must approve first); false → pay in PRANA (send msg.value).
    function register(string calldata name, uint256 years_, bool inKula) external payable nonReentrant {
        require(available(name), "taken");
        _validate(name);
        uint256 cost = priceOf(name, years_, inKula);
        _collect(inKula, cost);

        uint256 t = id(name);
        // re-registration of a long-expired name: burn the stale NFT first.
        if (_rec[t].expires != 0 && _ownerOf(t) != address(0)) _burn(t);
        uint64 exp = uint64(block.timestamp + years_ * 365 days);
        _rec[t] = Record({expires: exp, addr: msg.sender, contenthash: bytes32(0)});
        nameOf[t] = name;
        _safeMint(msg.sender, t);
        emit Registered(t, name, msg.sender, exp, inKula, cost);
    }

    /// @notice Renew an existing name (anyone may pay; during grace only the owner may, enforced by `available`).
    function renew(string calldata name, uint256 years_, bool inKula) external payable nonReentrant {
        uint256 t = id(name);
        require(_rec[t].expires != 0, "unregistered");
        require(block.timestamp <= uint256(_rec[t].expires) + GRACE_PERIOD, "expired");
        require(years_ >= 1 && years_ <= MAX_YEARS, "years");
        uint256 cost = priceOf(name, years_, inKula);
        _collect(inKula, cost);
        // extend from max(now, current expiry)
        uint64 base = _rec[t].expires > block.timestamp ? _rec[t].expires : uint64(block.timestamp);
        uint64 exp = base + uint64(years_ * 365 days);
        _rec[t].expires = exp;
        emit Renewed(t, name, exp, inKula, cost);
    }

    function _collect(bool inKula, uint256 cost) internal {
        if (inKula) {
            require(msg.value == 0, "no native for kula");
            kula.safeTransferFrom(msg.sender, feeRecipient, cost);
        } else {
            require(msg.value == cost, "bad PRANA value");
            (bool ok, ) = payable(feeRecipient).call{value: cost}("");
            require(ok, "PRANA xfer");
        }
    }

    // ── records (only the current, non-expired owner) ────────────────────────────────────────────────
    modifier onlyHolder(uint256 t) {
        require(_ownerOf(t) == msg.sender, "not owner");
        require(block.timestamp <= _rec[t].expires, "expired");
        _;
    }
    function setAddr(string calldata name, address a) external onlyHolder(id(name)) { _rec[id(name)].addr = a; emit AddrSet(id(name), a); }
    function setContenthash(string calldata name, bytes32 h) external onlyHolder(id(name)) { _rec[id(name)].contenthash = h; emit ContenthashSet(id(name), h); }
    function setText(string calldata name, string calldata key, string calldata value) external onlyHolder(id(name)) { _text[id(name)][key] = value; emit TextSet(id(name), key, value); }

    // ── admin ─────────────────────────────────────────────────────────────────────────────────────────
    function setTld(string calldata tld, bool allowed) external onlyRole(ADMIN_ROLE) { tldAllowed[keccak256(bytes(tld))] = allowed; emit TldSet(tld, allowed); }
    function setPrices(uint256[5] calldata prana_, uint256[5] calldata kula_) external onlyRole(ADMIN_ROLE) { annualPrana = prana_; annualKula = kula_; emit PricesSet(); }
    function setFeeRecipient(address r) external onlyRole(ADMIN_ROLE) { require(r != address(0), "zero"); feeRecipient = r; }
    function setKula(address k) external onlyRole(ADMIN_ROLE) { kula = IERC20(k); }

    // ── validation: lowercase a-z 0-9 '-' label + a dot + an allowlisted tld; total <=255 ───────────────
    function _tierIndex(string memory name) internal pure returns (uint256) {
        uint256 len = _labelLen(name);
        uint256 idx = len >= 5 ? 5 : len; // len is >=1 after _validate; views may be called pre-validate
        return idx == 0 ? 0 : idx - 1;
    }
    function _labelLen(string memory name) internal pure returns (uint256) {
        bytes memory b = bytes(name);
        for (uint256 i = 0; i < b.length; i++) { if (b[i] == ".") return i; }
        return b.length;
    }
    function _validate(string calldata name) internal view {
        bytes memory b = bytes(name);
        require(b.length >= 3 && b.length <= 255, "len");
        uint256 dot = type(uint256).max;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == ".") { require(dot == type(uint256).max, "one dot"); dot = i; continue; }
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d; // a-z 0-9 -
            require(ok, "char");
        }
        require(dot != type(uint256).max && dot >= 1 && dot < b.length - 1, "label.tld");
        // tld must be allowlisted
        bytes memory tld = new bytes(b.length - dot - 1);
        for (uint256 j = dot + 1; j < b.length; j++) tld[j - dot - 1] = b[j];
        require(tldAllowed[keccak256(tld)], "tld");
    }

    // soulless transfers still allowed (names are tradeable); records persist with the token.
    function supportsInterface(bytes4 iid) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(iid);
    }
}
