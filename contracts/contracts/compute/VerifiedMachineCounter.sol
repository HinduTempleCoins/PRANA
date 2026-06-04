// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IVerifiedMachineCounter} from "../interfaces/IVerifiedMachineCounter.sol";

/// @title VerifiedMachineCounter (PP4) — Sybil-resistant count of SUSTAINED verified machines.
/// @notice Feeds threshold-X of {CountercyclicalFeeOracle}. Answers ONE question honestly: how
///         many verified, work-contributing machines have been continuously active across a
///         trailing window?
///
///         Design tenets:
///         - Count ONLY verified work-contributing machines. A REGISTRAR role (a humanity /
///           verification gate — e.g. an attestation module or DAO-run registrar) admits a machine
///           id once it has passed verification. A fake node doing no verifiable work is never
///           registered, so it never counts.
///         - Count ONLY machines SUSTAINED over the window, never a momentary spike. The trailing
///           window is split into `buckets` equal time slices; a machine counts toward
///           {sustainedCount} only if a verified heartbeat landed in EVERY one of those buckets.
///           So a flash of N fake heartbeats in a single bucket cannot trip X — they must be kept
///           alive (and re-verified) across the whole window, which is expensive and observable.
///         - Decay is automatic: a machine that goes idle stops heartbeating, misses buckets, and
///           silently drops out of {sustainedCount} with no on-chain "remove" call required.
///
///         This contract intentionally does NOT verify the work itself — that is the registrar's
///         job (off-chain verification, same trust model as BOINC/GridCoin). This contract is the
///         on-chain SUSTAIN + Sybil-window accounting layer on top of that gate.
///
/// @dev Heartbeat accounting is O(1) per heartbeat and O(buckets) per registered machine for the
///      read. `sustainedCount()` recomputes from per-machine bucket bitmaps so it never returns a
///      stale spike; it is a view (cheap for off-chain callers, and the fee hook reads it once per
///      settlement). For large fleets prefer reading off-chain / via multicall.
contract VerifiedMachineCounter is AccessControl, IVerifiedMachineCounter {
    /// @notice Role that admits verified machines and posts their heartbeats. Held by the
    ///         humanity/verification gate (attestation module, DAO registrar). MUST only register
    ///         a machine that has passed off-chain work verification.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice Length of the full trailing sustain window, in seconds.
    uint256 public immutable window;
    /// @notice Number of equal time-slices the window is divided into for the sustain check.
    ///         A machine must heartbeat in EVERY slice to be counted. More buckets = stricter
    ///         (finer-grained) sustain requirement.
    uint256 public immutable buckets;
    /// @dev Cached `window / buckets`.
    uint256 public immutable bucketLength;

    struct Machine {
        bool registered;       // admitted by the registrar (passed verification)
        uint64 lastBeatBucket; // global bucket index of the most recent heartbeat (+1; 0 = never)
        // Rolling bitmap of which of the last `buckets` slices saw a heartbeat. Bit i (LSB-first)
        // corresponds to the slice `currentBucket - i`. All low `buckets` bits set => sustained.
        uint256 beatMask;
    }

    mapping(bytes32 => Machine) private _machines;
    /// @notice All machine ids ever registered (registration is sticky; idle machines just stop
    ///         counting via the window check, they are not deleted).
    bytes32[] private _ids;

    event MachineRegistered(bytes32 indexed machineId);
    event Heartbeat(bytes32 indexed machineId, uint256 indexed bucket);

    error BadWindow();
    error NotRegistered();
    error AlreadyRegistered();

    /// @param admin   Receives DEFAULT_ADMIN_ROLE + REGISTRAR_ROLE (transfer/renounce as desired).
    /// @param window_ Trailing sustain window in seconds (e.g. 7 days).
    /// @param buckets_ Slices the window is divided into (e.g. 7 => one beat/day required). Must be
    ///        >=1, <=256, and divide `window_` so bucket boundaries are uniform.
    constructor(address admin, uint256 window_, uint256 buckets_) {
        require(admin != address(0), "admin=0");
        if (buckets_ == 0 || buckets_ > 256 || window_ == 0 || window_ % buckets_ != 0) {
            revert BadWindow();
        }
        window = window_;
        buckets = buckets_;
        bucketLength = window_ / buckets_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    /// @notice The global bucket index for the current time.
    function currentBucket() public view returns (uint256) {
        return block.timestamp / bucketLength;
    }

    /// @notice Admit a verified, work-contributing machine. Caller (registrar) attests that the
    ///         machine has passed off-chain work verification. Registration alone does NOT make a
    ///         machine count toward {sustainedCount}; it must then heartbeat across the window.
    function registerMachine(bytes32 machineId) external onlyRole(REGISTRAR_ROLE) {
        Machine storage m = _machines[machineId];
        if (m.registered) revert AlreadyRegistered();
        m.registered = true;
        _ids.push(machineId);
        emit MachineRegistered(machineId);
    }

    /// @notice Post a verified-work heartbeat for `machineId` in the current bucket. Idempotent
    ///         within a bucket (extra beats in the same slice do nothing — a spike of beats in one
    ///         slice cannot fill the window). The registrar posts this only when it has fresh
    ///         off-chain proof the machine did verifiable work this slice.
    function heartbeat(bytes32 machineId) external onlyRole(REGISTRAR_ROLE) {
        Machine storage m = _machines[machineId];
        if (!m.registered) revert NotRegistered();

        uint256 cur = currentBucket();
        uint256 mask = _rolled(m, cur);
        // Set the current slice's bit (bit 0).
        mask |= 1;
        m.beatMask = mask;
        m.lastBeatBucket = uint64(cur + 1);
        emit Heartbeat(machineId, cur);
    }

    /// @notice Count of machines sustained across the ENTIRE current window (a verified heartbeat
    ///         in every slice). This is the Sybil-resistant number the fee oracle reads.
    function sustainedCount() external view returns (uint256 count) {
        uint256 cur = currentBucket();
        uint256 full = _fullMask();
        uint256 n = _ids.length;
        for (uint256 i = 0; i < n; i++) {
            Machine storage m = _machines[_ids[i]];
            if ((_rolled(m, cur) & full) == full) {
                count++;
            }
        }
    }

    /// @notice True if `machineId` is currently sustained over the full window.
    function isSustained(bytes32 machineId) external view returns (bool) {
        Machine storage m = _machines[machineId];
        if (!m.registered) return false;
        uint256 full = _fullMask();
        return (_rolled(m, currentBucket()) & full) == full;
    }

    /// @notice Whether `machineId` has been registered (admitted by the verification gate).
    function isRegistered(bytes32 machineId) external view returns (bool) {
        return _machines[machineId].registered;
    }

    /// @notice Total number of machines ever registered (includes idle/decayed ones).
    function registeredCount() external view returns (uint256) {
        return _ids.length;
    }

    // --------------------------------------------------------------------- //
    //                              internals                                //
    // --------------------------------------------------------------------- //

    /// @dev Bitmask with the low `buckets` bits set — the "all slices present" target.
    function _fullMask() internal view returns (uint256) {
        return buckets == 256 ? type(uint256).max : (uint256(1) << buckets) - 1;
    }

    /// @dev The machine's beat bitmap rolled forward to bucket `cur`. Each bucket of elapsed time
    ///      shifts older beats toward higher bits; bits that roll past slice `buckets-1` fall off
    ///      the window (decay). Returns the rolled mask WITHOUT mutating storage (safe for views).
    function _rolled(Machine storage m, uint256 cur) internal view returns (uint256) {
        if (m.lastBeatBucket == 0) return 0; // never beat
        uint256 last = uint256(m.lastBeatBucket) - 1;
        if (cur <= last) return m.beatMask; // same bucket (or clock skew) — no roll
        uint256 shift = cur - last;
        if (shift >= buckets) return 0; // fully decayed out of the window
        return m.beatMask << shift;
    }
}
