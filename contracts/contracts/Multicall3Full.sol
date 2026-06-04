// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Multicall3Full
/// @notice The full canonical Multicall3 surface — batches many calls into one transaction and
///         returns each result, with per-call failure tolerance and optional value forwarding.
///         A superset of the in-repo {Multicall}; deploy this where tools expect the standard
///         Multicall3 ABI (aggregate3 / aggregate3Value / tryAggregate / blockAndAggregate +
///         the block helper getters).
/// @dev Shape matches the well-known Multicall3 at 0xcA11bde05977b3631167028862bE2a173976CA11.
///      State-mutating because aggregate3Value/value-forwarding paths can move ETH.
contract Multicall3Full {
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    error CallFailed(uint256 index);
    error ValueMismatch(uint256 supplied, uint256 required);

    /// @notice Aggregate calls, honoring each call's allowFailure flag.
    function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Call3 calldata c = calls[i];
            (bool success, bytes memory ret) = c.target.call(c.callData);
            if (!success && !c.allowFailure) revert CallFailed(i);
            returnData[i] = Result({success: success, returnData: ret});
        }
    }

    /// @notice Aggregate calls with per-call ETH value; the supplied msg.value must exactly cover
    ///         the sum of all call values.
    function aggregate3Value(Call3Value[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        uint256 valAccumulator;
        for (uint256 i = 0; i < length; i++) {
            Call3Value calldata c = calls[i];
            uint256 val = c.value;
            valAccumulator += val;
            (bool success, bytes memory ret) = c.target.call{value: val}(c.callData);
            if (!success && !c.allowFailure) revert CallFailed(i);
            returnData[i] = Result({success: success, returnData: ret});
        }
        if (msg.value != valAccumulator) revert ValueMismatch(msg.value, valAccumulator);
    }

    /// @notice Aggregate calls; if requireSuccess all must succeed, else failures are tolerated.
    function tryAggregate(bool requireSuccess, Call[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (requireSuccess && !success) revert CallFailed(i);
            returnData[i] = Result({success: success, returnData: ret});
        }
    }

    /// @notice tryAggregate, additionally returning the executing block number and hash.
    function tryBlockAndAggregate(bool requireSuccess, Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
    {
        blockNumber = block.number;
        blockHash = blockhash(block.number);
        returnData = tryAggregate(requireSuccess, calls);
    }

    /// @notice Aggregate requiring all calls to succeed, returning block number and hash.
    function blockAndAggregate(Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
    {
        (blockNumber, blockHash, returnData) = tryBlockAndAggregate(true, calls);
    }

    // ---------------------------------------------------------------------- //
    //  Block / chain helper getters (canonical Multicall3 surface)           //
    // ---------------------------------------------------------------------- //

    function getBasefee() external view returns (uint256 basefee) {
        basefee = block.basefee;
    }

    function getBlockNumber() external view returns (uint256 blockNumber) {
        blockNumber = block.number;
    }

    function getChainId() external view returns (uint256 chainid) {
        chainid = block.chainid;
    }

    function getCurrentBlockTimestamp() external view returns (uint256 timestamp) {
        timestamp = block.timestamp;
    }

    function getBlockHash(uint256 blockNumber) external view returns (bytes32 blockHash) {
        blockHash = blockhash(blockNumber);
    }

    function getCurrentBlockCoinbase() external view returns (address coinbase) {
        coinbase = block.coinbase;
    }

    function getCurrentBlockGasLimit() external view returns (uint256 gaslimit) {
        gaslimit = block.gaslimit;
    }

    function getEthBalance(address addr) external view returns (uint256 balance) {
        balance = addr.balance;
    }

    function getLastBlockHash() external view returns (bytes32 blockHash) {
        unchecked {
            blockHash = blockhash(block.number - 1);
        }
    }
}
