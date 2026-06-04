// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMintable} from "./BurnMine.sol";

/// @title SupplyController — role-gated minting with a hard per-epoch cap
/// @notice A safety valve between emission modules and a token: holders of EMITTER_ROLE can mint,
///         but never more than `capPerEpoch` in any epoch. Bounds inflation by construction even if
///         an emitter is buggy or compromised. The token must grant this contract minter authority.
contract SupplyController is AccessControl {
    bytes32 public constant EMITTER_ROLE = keccak256("EMITTER_ROLE");

    IMintable public immutable token;
    uint256 public immutable capPerEpoch;
    uint64 public immutable epochLength;
    uint64 public immutable start;

    mapping(uint64 => uint256) public mintedInEpoch;

    event Minted(address indexed to, uint256 amount, uint64 epoch);

    constructor(IMintable token_, uint256 capPerEpoch_, uint64 epochLength_, address admin) {
        require(address(token_) != address(0) && admin != address(0), "zero");
        require(capPerEpoch_ > 0 && epochLength_ > 0, "bad params");
        token = token_;
        capPerEpoch = capPerEpoch_;
        epochLength = epochLength_;
        start = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EMITTER_ROLE, admin);
    }

    function currentEpoch() public view returns (uint64) {
        return (uint64(block.timestamp) - start) / epochLength;
    }

    function remainingThisEpoch() external view returns (uint256) {
        return capPerEpoch - mintedInEpoch[currentEpoch()];
    }

    function mintCapped(address to, uint256 amount) external onlyRole(EMITTER_ROLE) {
        require(amount > 0, "amount=0");
        uint64 e = currentEpoch();
        require(mintedInEpoch[e] + amount <= capPerEpoch, "epoch cap");
        mintedInEpoch[e] += amount;
        token.mint(to, amount);
        emit Minted(to, amount, e);
    }
}
