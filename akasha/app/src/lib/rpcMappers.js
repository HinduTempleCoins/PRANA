// rpcMappers.js — pure JSON-RPC response mappers for the explorer/wallet.
//
// These take RAW eth_* JSON-RPC result objects (the wire shape: hex-quantity
// strings, lowercase) and normalize them into plain objects the UI components
// consume. PURE — no fetch, no ethers — so they are unit-testable in isolation.
//
// We deliberately keep hex->bigint conversions here (not in the components) so
// every numeric field has a single, tested coercion point.

// Coerce a hex/decimal quantity string to BigInt. null/undefined -> null.
export function quantityToBig(v) {
  if (v == null) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

// Coerce to Number where the value is known-small (block number, tx count).
// Falls back to null if it would lose precision.
export function quantityToNumber(v) {
  const b = quantityToBig(v);
  if (b == null) return null;
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}

// Map an eth_getBlockByNumber/Hash result into a summary row for the block list.
// `fullTx` may be false (txs is an array of hashes) or true (array of objects).
export function mapBlockSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const txs = Array.isArray(raw.transactions) ? raw.transactions : [];
  return {
    number: quantityToNumber(raw.number),
    numberBig: quantityToBig(raw.number),
    hash: raw.hash ?? null,
    parentHash: raw.parentHash ?? null,
    timestamp: quantityToNumber(raw.timestamp),
    txCount: txs.length,
    gasUsed: quantityToBig(raw.gasUsed),
    gasLimit: quantityToBig(raw.gasLimit),
    baseFeePerGas: quantityToBig(raw.baseFeePerGas),
    miner: raw.miner ?? raw.author ?? null,
  };
}

// Map a full block (txs as objects) for the block-detail view.
export function mapBlockDetail(raw) {
  const summary = mapBlockSummary(raw);
  if (!summary) return null;
  const txObjects = Array.isArray(raw.transactions) ? raw.transactions : [];
  const txsAreObjects = txObjects.length > 0 && typeof txObjects[0] === 'object';
  return {
    ...summary,
    extraData: raw.extraData ?? null,
    stateRoot: raw.stateRoot ?? null,
    transactions: txsAreObjects ? txObjects.map(mapTransaction) : txObjects, // objects -> mapped, else hashes
    txsAreObjects,
  };
}

// Map an eth_getTransactionByHash result.
export function mapTransaction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    hash: raw.hash ?? null,
    from: raw.from ?? null,
    to: raw.to ?? null, // null => contract creation
    value: quantityToBig(raw.value),
    nonce: quantityToNumber(raw.nonce),
    gas: quantityToBig(raw.gas),
    gasPrice: quantityToBig(raw.gasPrice),
    maxFeePerGas: quantityToBig(raw.maxFeePerGas),
    blockNumber: quantityToNumber(raw.blockNumber),
    blockHash: raw.blockHash ?? null,
    input: raw.input ?? '0x',
    type: quantityToNumber(raw.type),
  };
}

// Merge a tx with its receipt (eth_getTransactionReceipt) for the tx-detail view.
// receipt may be null (pending). Returns a unified record with a `status` field:
//   'success' | 'failed' | 'pending' | 'unknown'
export function mapTxWithReceipt(txRaw, receiptRaw) {
  const tx = mapTransaction(txRaw);
  if (!tx) return null;
  let status = 'unknown';
  let gasUsed = null;
  let contractAddress = null;
  let effectiveGasPrice = null;
  if (receiptRaw && typeof receiptRaw === 'object') {
    const s = receiptRaw.status;
    if (s === '0x1' || s === 1 || s === '0x01') status = 'success';
    else if (s === '0x0' || s === 0 || s === '0x00') status = 'failed';
    gasUsed = quantityToBig(receiptRaw.gasUsed);
    contractAddress = receiptRaw.contractAddress ?? null;
    effectiveGasPrice = quantityToBig(receiptRaw.effectiveGasPrice);
  } else if (tx.blockNumber == null) {
    status = 'pending';
  }
  return { ...tx, status, gasUsed, contractAddress, effectiveGasPrice };
}

// Classify an address from eth_getCode: '0x' (or empty) => EOA, else contract.
export function classifyAddress(code) {
  if (code == null) return 'unknown';
  if (code === '0x' || code === '0x0' || code === '') return 'eoa';
  return 'contract';
}

// Build an address summary record for the AddressCard.
export function mapAddressInfo({ address, balanceWei, code, txCount }) {
  return {
    address: address ?? null,
    balance: quantityToBig(balanceWei),
    kind: classifyAddress(code),
    codeSize: code && code !== '0x' ? (code.length - 2) / 2 : 0,
    txCount: quantityToNumber(txCount),
  };
}
