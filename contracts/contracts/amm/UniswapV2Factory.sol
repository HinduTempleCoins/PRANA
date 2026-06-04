// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {UniswapV2Pair} from "./UniswapV2Pair.sol";

/// @title UniswapV2Factory
/// @notice Canonical Uniswap V2 core factory ported from Solidity 0.5.16 to 0.8.24.
/// @dev PORTING NOTES:
///      - create2 salt = keccak256(abi.encodePacked(token0, token1)) (canonical V2 salt).
///      - 0.8.x supports `new C{salt: ...}()`, so the original inline-assembly create2 is
///        replaced with the high-level salted-new form (equivalent address derivation).
contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Init code hash of UniswapV2Pair creation bytecode. Used by off-chain/router
    ///         code that wants to compute pair addresses deterministically.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(UniswapV2Pair).creationCode);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "UniswapV2: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "UniswapV2: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "UniswapV2: PAIR_EXISTS"); // single check is sufficient

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new UniswapV2Pair{salt: salt}());
        UniswapV2Pair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "UniswapV2: FORBIDDEN");
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "UniswapV2: FORBIDDEN");
        feeToSetter = _feeToSetter;
    }
}
