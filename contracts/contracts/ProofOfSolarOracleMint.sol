// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMintable} from "./BurnMine.sol";

/// @title ProofOfSolarOracleMint — mint-on-proof of verified solar generation
/// @notice An allowlisted attestor reports verified kWh for a producer; the contract mints reward
///         tokens at `ratePerKwh`, bounded by a per-period cap. Each proof id is single-use. Improves
///         on SolarCoin: mint-on-proof only (no pre-allocated pool / premine), attestor-gated, capped.
///         The reward token must grant this contract minter authority. Attestor stake/slash lives in
///         a separate AttestationStakeSlash module (kept modular).
contract ProofOfSolarOracleMint is AccessControl {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

    IMintable public immutable rewardToken;
    uint256 public immutable ratePerKwh;
    uint256 public immutable periodCapKwh;
    uint64 public immutable periodLength;

    uint64 public periodStart;
    uint256 public mintedKwhThisPeriod;
    mapping(bytes32 => bool) public usedProof;

    event SolarMinted(address indexed producer, uint256 kwh, uint256 minted, bytes32 indexed proof);

    constructor(IMintable rewardToken_, uint256 ratePerKwh_, uint256 periodCapKwh_, uint64 periodLength_, address admin) {
        require(address(rewardToken_) != address(0) && admin != address(0), "zero");
        require(ratePerKwh_ > 0 && periodCapKwh_ > 0 && periodLength_ > 0, "bad params");
        rewardToken = rewardToken_;
        ratePerKwh = ratePerKwh_;
        periodCapKwh = periodCapKwh_;
        periodLength = periodLength_;
        periodStart = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, admin);
    }

    function _roll() internal {
        if (block.timestamp >= periodStart + periodLength) {
            periodStart = uint64(block.timestamp);
            mintedKwhThisPeriod = 0;
        }
    }

    function attest(address producer, uint256 kwh, bytes32 proof) external onlyRole(ATTESTOR_ROLE) {
        require(producer != address(0), "producer=0");
        require(kwh > 0, "kwh=0");
        require(!usedProof[proof], "proof used");
        _roll();
        require(mintedKwhThisPeriod + kwh <= periodCapKwh, "period cap");
        usedProof[proof] = true;
        mintedKwhThisPeriod += kwh;
        uint256 amount = kwh * ratePerKwh;
        rewardToken.mint(producer, amount);
        emit SolarMinted(producer, kwh, amount, proof);
    }
}
