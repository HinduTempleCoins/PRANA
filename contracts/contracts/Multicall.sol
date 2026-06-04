// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Multicall
/// @notice Multicall3-style stateless batched call aggregator. Lets a caller
///         fan out many calls (typically read-only staticcalls) in a single
///         transaction and collect their return data.
contract Multicall {
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    /// @notice Aggregate calls, reverting if any one of them fails.
    /// @param calls An array of {target, callData} to execute.
    /// @return blockNumber The block number the batch executed in.
    /// @return returnData The raw return data of each call, in order.
    function aggregate(Call[] calldata calls)
        external
        returns (uint256 blockNumber, bytes[] memory returnData)
    {
        blockNumber = block.number;
        uint256 length = calls.length;
        returnData = new bytes[](length);
        for (uint256 i = 0; i < length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(success, "Multicall: call failed");
            returnData[i] = ret;
        }
    }

    /// @notice Aggregate calls, honoring each call's allowFailure flag.
    /// @param calls An array of {target, allowFailure, callData} to execute.
    /// @return returnData An array of {success, returnData} per call.
    function aggregate3(Call3[] calldata calls)
        external
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Call3 calldata call = calls[i];
            (bool success, bytes memory ret) = call.target.call(call.callData);
            if (!success && !call.allowFailure) {
                revert("Multicall: call failed");
            }
            returnData[i] = Result({success: success, returnData: ret});
        }
    }
}
