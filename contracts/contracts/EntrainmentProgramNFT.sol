// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EntrainmentProgramNFT — published entrainment "dose" programs as NFTs (BI14, §9)
/// @notice A creator PUBLISHES a named entrainment program (a "master template"); buyers then
///         MINT an edition NFT that references that template. The template is on-chain metadata
///         only — name, a `programHash` (bytes32) that anchors the off-chain bands / protocol /
///         audio bundle, the creator, the per-edition price, and a packed "dose" descriptor
///         (duration + band-set), plus an optional `doseURI` for the full descriptor.
///
///         NFT MODEL — template + edition (chosen):
///           - Publishing a program creates a template (NOT an NFT). The template is the master
///             record held by the creator.
///           - Each purchase mints a fresh ERC-721 EDITION token to the buyer. Every edition
///             carries the id of the template it was minted from, so any number of buyers can
///             own a personal, transferable license-copy of the same program.
///           - This keeps "the program" (the published intent) separate from "a license to it"
///             (the thing a buyer holds and can resell), which is the cleaner ownership model
///             for a marketplace.
///
///         PAYMENTS: price is denominated either in the native coin or in a single ERC-20,
///         chosen per-template at publish time (`payToken == address(0)` ⇒ native). Each sale
///         routes the price to the creator MINUS an optional protocol cut (basis points) sent
///         to a protocol treasury. EIP-2981 royalties are configured per template so secondary
///         sales on a compliant marketplace pay the creator.
///
/// @dev IMPORTANT (health-adjacent): this contract makes and stores NO therapeutic claims and
///      is NOT medical advice. `programHash` / `doseURI` point to off-chain content that MUST
///      carry the disclaimers and safety contraindications described in
///      design/bio/health-guardrails.md. The chain is an accounting + licensing rail only.
contract EntrainmentProgramNFT is ERC721, ERC2981, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis-points denominator (100% = 10_000).
    uint96 public constant BPS_DENOMINATOR = 10_000;

    /// @notice A published entrainment program (master template). Not itself an NFT.
    struct Program {
        address creator;      // who published it; receives sale proceeds (net of protocol cut)
        address payToken;     // ERC-20 used for payment; address(0) == native coin
        uint256 price;        // per-edition price, in payToken's smallest unit (or wei if native)
        bytes32 programHash;  // anchor for the off-chain bands/protocol/audio bundle
        uint32 durationSecs;  // "dose" duration in seconds (descriptor)
        uint64 bandSet;       // packed band-set descriptor (e.g. bitfield of band presets)
        bool active;          // editions can only be minted while active
        string name;          // human-readable program name
        string doseURI;       // full off-chain dose descriptor (bands/protocol/audio + disclaimers)
    }

    /// @notice True if anyone may publish a program; false if only the owner may.
    bool public publishPermissionless;

    /// @notice Protocol cut taken from each sale, in basis points (e.g. 250 = 2.5%).
    uint96 public protocolFeeBps;

    /// @notice Receiver of the protocol cut.
    address public protocolTreasury;

    uint256 private _nextProgramId;
    uint256 private _nextTokenId;

    /// @notice programId => Program template.
    mapping(uint256 => Program) private _programs;
    /// @notice tokenId (edition) => the programId it was minted from.
    mapping(uint256 => uint256) public templateOf;

    event ProgramPublished(
        uint256 indexed programId,
        address indexed creator,
        bytes32 programHash,
        address payToken,
        uint256 price
    );
    event EditionMinted(
        uint256 indexed tokenId,
        uint256 indexed programId,
        address indexed buyer,
        uint256 pricePaid,
        uint256 protocolCut
    );
    event ProgramActiveSet(uint256 indexed programId, bool active);
    event ProgramPriceSet(uint256 indexed programId, uint256 price);
    event PublishPermissionlessSet(bool permissionless);
    event ProtocolFeeSet(address treasury, uint96 feeBps);

    error ZeroAddress();
    error PublishNotPermitted();
    error EmptyName();
    error ZeroProgramHash();
    error FeeTooHigh();
    error NonexistentProgram();
    error ProgramInactive();
    error NotProgramCreator();
    error WrongPayment();
    error NativeNotAccepted();

    /// @param admin              Owner (admin) of the contract; also initial protocol treasury fallback.
    /// @param protocolTreasury_  Receiver of the protocol cut (may equal admin).
    /// @param protocolFeeBps_    Protocol cut in basis points (<= BPS_DENOMINATOR).
    /// @param publishPermissionless_ If true anyone may publish; else only the owner.
    constructor(
        address admin,
        address protocolTreasury_,
        uint96 protocolFeeBps_,
        bool publishPermissionless_
    ) ERC721("PRANA Entrainment Program", "ENTRAIN") Ownable(admin) {
        if (admin == address(0) || protocolTreasury_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > BPS_DENOMINATOR) revert FeeTooHigh();
        protocolTreasury = protocolTreasury_;
        protocolFeeBps = protocolFeeBps_;
        publishPermissionless = publishPermissionless_;
    }

    // --------------------------------------------------------------------- //
    //                              publish                                  //
    // --------------------------------------------------------------------- //

    /// @notice Publish a new entrainment program (master template). Mints NO NFT itself.
    /// @param name_         Human-readable program name (non-empty).
    /// @param programHash   Anchor for the off-chain bands/protocol/audio bundle (non-zero).
    /// @param payToken      ERC-20 used for payment; address(0) for the native coin.
    /// @param price         Per-edition price in payToken units (or wei if native). May be 0 (free).
    /// @param durationSecs  "Dose" duration in seconds.
    /// @param bandSet       Packed band-set descriptor.
    /// @param doseURI       Off-chain dose descriptor URI (bands/protocol/audio + disclaimers).
    /// @param royaltyBps    EIP-2981 secondary-sale royalty for this program, in basis points.
    /// @return programId    The id of the newly published program.
    function publishProgram(
        string calldata name_,
        bytes32 programHash,
        address payToken,
        uint256 price,
        uint32 durationSecs,
        uint64 bandSet,
        string calldata doseURI,
        uint96 royaltyBps
    ) external returns (uint256 programId) {
        if (!publishPermissionless && msg.sender != owner()) revert PublishNotPermitted();
        if (bytes(name_).length == 0) revert EmptyName();
        if (programHash == bytes32(0)) revert ZeroProgramHash();
        if (royaltyBps > BPS_DENOMINATOR) revert FeeTooHigh();

        programId = _nextProgramId++;
        _programs[programId] = Program({
            creator: msg.sender,
            payToken: payToken,
            price: price,
            programHash: programHash,
            durationSecs: durationSecs,
            bandSet: bandSet,
            active: true,
            name: name_,
            doseURI: doseURI
        });

        // Secondary-sale royalties accrue to the creator for this program's editions.
        _setTokenRoyaltyForProgram(programId, msg.sender, royaltyBps);

        emit ProgramPublished(programId, msg.sender, programHash, payToken, price);
    }

    // --------------------------------------------------------------------- //
    //                            mint edition                              //
    // --------------------------------------------------------------------- //

    /// @notice Purchase and mint an edition of an active program. Routes payment to the creator
    ///         minus the protocol cut. Edition royalty (EIP-2981) is the program's royalty.
    /// @param programId Program (template) to mint an edition of.
    /// @param to        Recipient of the new edition NFT.
    /// @return tokenId  The id of the newly minted edition.
    function mintEdition(uint256 programId, address to)
        external
        payable
        nonReentrant
        returns (uint256 tokenId)
    {
        if (to == address(0)) revert ZeroAddress();
        Program storage p = _programs[programId];
        if (p.creator == address(0)) revert NonexistentProgram();
        if (!p.active) revert ProgramInactive();

        uint256 price = p.price;
        uint256 protocolCut = (price * protocolFeeBps) / BPS_DENOMINATOR;
        uint256 creatorAmount = price - protocolCut;

        if (p.payToken == address(0)) {
            // Native payment: exact value required.
            if (msg.value != price) revert WrongPayment();
            if (protocolCut > 0) _sendNative(protocolTreasury, protocolCut);
            if (creatorAmount > 0) _sendNative(p.creator, creatorAmount);
        } else {
            // ERC-20 payment: no native value allowed.
            if (msg.value != 0) revert NativeNotAccepted();
            IERC20 token = IERC20(p.payToken);
            if (protocolCut > 0) token.safeTransferFrom(msg.sender, protocolTreasury, protocolCut);
            if (creatorAmount > 0) token.safeTransferFrom(msg.sender, p.creator, creatorAmount);
        }

        tokenId = _nextTokenId++;
        templateOf[tokenId] = programId;
        _safeMint(to, tokenId);

        // Apply the program's royalty config to this edition token (EIP-2981).
        RoyaltyConfig memory rc = _programRoyalty[programId];
        if (rc.receiver != address(0)) _setTokenRoyalty(tokenId, rc.receiver, rc.feeBps);

        emit EditionMinted(tokenId, programId, to, price, protocolCut);
    }

    // --------------------------------------------------------------------- //
    //                         creator / admin                              //
    // --------------------------------------------------------------------- //

    /// @notice Activate or deactivate a program; inactive programs cannot mint editions.
    function setProgramActive(uint256 programId, bool active) external {
        Program storage p = _programs[programId];
        if (p.creator == address(0)) revert NonexistentProgram();
        if (msg.sender != p.creator && msg.sender != owner()) revert NotProgramCreator();
        p.active = active;
        emit ProgramActiveSet(programId, active);
    }

    /// @notice Update the per-edition price of a program (creator only).
    function setProgramPrice(uint256 programId, uint256 price) external {
        Program storage p = _programs[programId];
        if (p.creator == address(0)) revert NonexistentProgram();
        if (msg.sender != p.creator) revert NotProgramCreator();
        p.price = price;
        emit ProgramPriceSet(programId, price);
    }

    /// @notice Toggle whether publishing is permissionless (owner only).
    function setPublishPermissionless(bool permissionless) external onlyOwner {
        publishPermissionless = permissionless;
        emit PublishPermissionlessSet(permissionless);
    }

    /// @notice Update the protocol treasury and fee (owner only).
    function setProtocolFee(address treasury, uint96 feeBps) external onlyOwner {
        if (treasury == address(0)) revert ZeroAddress();
        if (feeBps > BPS_DENOMINATOR) revert FeeTooHigh();
        protocolTreasury = treasury;
        protocolFeeBps = feeBps;
        emit ProtocolFeeSet(treasury, feeBps);
    }

    // --------------------------------------------------------------------- //
    //                                reads                                 //
    // --------------------------------------------------------------------- //

    /// @notice Full program template record.
    function getProgram(uint256 programId) external view returns (Program memory) {
        Program memory p = _programs[programId];
        if (p.creator == address(0)) revert NonexistentProgram();
        return p;
    }

    /// @notice Total number of programs ever published (also the next program id).
    function programCount() external view returns (uint256) {
        return _nextProgramId;
    }

    /// @notice Total number of editions ever minted (also the next token id).
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _programs[templateOf[tokenId]].doseURI;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // --------------------------------------------------------------------- //
    //                              internal                                //
    // --------------------------------------------------------------------- //

    /// @notice Per-program royalty config, applied to each edition at mint time.
    mapping(uint256 => RoyaltyConfig) private _programRoyalty;

    struct RoyaltyConfig {
        address receiver;
        uint96 feeBps;
    }

    function _setTokenRoyaltyForProgram(uint256 programId, address receiver, uint96 feeBps) private {
        _programRoyalty[programId] = RoyaltyConfig({receiver: receiver, feeBps: feeBps});
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert WrongPayment();
    }
}
