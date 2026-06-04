import { formatEther, formatGwei, getAddress } from 'viem';

// Pure formatting helpers for Akasha's read-only block/tx/address explorer view.
// The explorer pillar reads results from PRANA's JSON-RPC; these functions turn
// the raw RPC objects (bigints, 0x-hex quantities) into display-ready values.
//
// All helpers are offline and operate on plain objects — no RPC calls here.

// Coerce an RPC quantity (bigint, hex string, decimal string, or number) to a
// bigint. RPC returns hex-encoded quantities; ethers/viem return bigints.
function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`expected an integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    // BigInt() understands both '0x..' hex and plain decimal strings.
    return BigInt(value);
  }
  throw new Error(`cannot convert ${typeof value} to bigint`);
}

// Format a block. Accepts bigint or hex-string fields as returned by RPC.
// Returns decimal counts and an ISO-8601 UTC timestamp.
export function formatBlock(block) {
  if (block === null || typeof block !== 'object') {
    throw new Error('block must be an object');
  }

  const number = toBigInt(block.number);
  const timestamp = toBigInt(block.timestamp);
  const gasUsed = toBigInt(block.gasUsed);
  const gasLimit = toBigInt(block.gasLimit);

  const txCount = Array.isArray(block.transactions)
    ? block.transactions.length
    : toBigInt(block.transactions ?? 0);

  return {
    number: number.toString(),
    hash: block.hash,
    // Unix seconds → milliseconds for Date, then ISO-8601 (UTC).
    timestamp: new Date(Number(timestamp) * 1000).toISOString(),
    txCount: typeof txCount === 'bigint' ? txCount.toString() : String(txCount),
    gasUsed: gasUsed.toString(),
    gasLimit: gasLimit.toString(),
  };
}

// Format a transaction. value → PRANA (18-decimal, via formatEther — under the
// hood the smallest unit is still wei); gasPrice → gwei. Addresses checksummed.
export function formatTx(tx) {
  if (tx === null || typeof tx !== 'object') {
    throw new Error('tx must be an object');
  }

  const value = toBigInt(tx.value);
  const nonce = toBigInt(tx.nonce);
  const gasPrice = toBigInt(tx.gasPrice);

  return {
    hash: tx.hash,
    from: getAddress(tx.from),
    // Contract-creation txs have a null `to`.
    to: tx.to == null ? null : getAddress(tx.to),
    valuePrana: formatEther(value),
    nonce: nonce.toString(),
    gasPriceGwei: formatGwei(gasPrice),
  };
}

// Format an address summary: checksummed address, balance in PRANA, tx count.
export function formatAddressSummary({ address, balanceWei, txCount }) {
  const count = toBigInt(txCount);
  return {
    address: getAddress(address),
    balancePrana: formatEther(toBigInt(balanceWei)),
    txCount: count.toString(),
  };
}

// Truncate a hash/address to '0x1234…abcd' for compact display.
export function shortHash(h) {
  if (typeof h !== 'string' || !h.startsWith('0x')) {
    throw new Error('shortHash expects a 0x-prefixed string');
  }
  // 0x + 4 + … + 4 = 12 chars; shorter values are returned unchanged.
  if (h.length <= 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}
