// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IWorkerBeacon — minimal surface the lane creditors need from the WorkerBeaconRegistry.
/// @notice A sibling builds the full WorkerBeaconRegistry (worker<->beacon binding, heartbeat,
///         reputation, etc.). The creditors only need to know "is this address a bound worker?"
///         so they never credit shares to an unregistered / unbeaconed address. Depend on THIS
///         interface, not the registry's file. If a creditor is configured with the zero address
///         for the beacon, the check is skipped (open mode).
interface IWorkerBeacon {
    /// @notice True once `worker` has bound a live beacon (is an eligible recipient of shares).
    function isBound(address worker) external view returns (bool);
}
