import { formatUnits, parseUnits, isAddress, getAddress } from 'viem';

// Normalize and validate a single token entry.
// Returns a frozen { address, symbol, decimals, name } with a checksummed address.
function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error('token entry must be an object');
  }

  const { address, symbol, decimals, name } = entry;

  if (typeof address !== 'string' || !isAddress(address)) {
    throw new Error(`invalid token address: ${String(address)}`);
  }
  // getAddress throws on a bad checksum / malformed address and returns the
  // canonical EIP-55 checksummed form otherwise.
  const checksummed = getAddress(address);

  if (typeof symbol !== 'string' || symbol.length === 0) {
    throw new Error(`invalid token symbol for ${checksummed}`);
  }

  if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    throw new Error(
      `invalid token decimals for ${symbol} (${checksummed}): must be an integer 0..36`,
    );
  }

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`invalid token name for ${symbol} (${checksummed})`);
  }

  return Object.freeze({ address: checksummed, symbol, decimals, name });
}

// Build a validated, normalized token list with bySymbol / byAddress indexes.
// Throws on any bad entry.
export function makeTokenList(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('entries must be an array');
  }

  const tokens = [];
  const bySymbol = new Map();
  const byAddress = new Map();

  for (const entry of entries) {
    const token = normalizeEntry(entry);

    if (bySymbol.has(token.symbol)) {
      throw new Error(`duplicate token symbol: ${token.symbol}`);
    }
    if (byAddress.has(token.address)) {
      throw new Error(`duplicate token address: ${token.address}`);
    }

    tokens.push(token);
    bySymbol.set(token.symbol, token);
    byAddress.set(token.address, token);
  }

  return { tokens, bySymbol, byAddress };
}

// Build a token list from a deployments.json-style map:
//   { contracts: { Name: address, ... } }
// Defaults decimals to 18 and uses the contract Name as the token symbol/name.
export function fromDeployments(deploymentsJson) {
  if (deploymentsJson === null || typeof deploymentsJson !== 'object') {
    throw new Error('deployments must be an object');
  }

  const contracts = deploymentsJson.contracts;
  if (contracts === null || typeof contracts !== 'object') {
    throw new Error('deployments.contracts must be an object');
  }

  const entries = Object.entries(contracts).map(([name, address]) => ({
    address,
    symbol: name,
    decimals: 18,
    name,
  }));

  return makeTokenList(entries);
}

// Format a base-unit amount (bigint/string) into a human-readable decimal string.
export function format(amount, decimals) {
  return formatUnits(amount, decimals);
}

// Parse a human-readable decimal string into a base-unit bigint.
export function parse(str, decimals) {
  return parseUnits(str, decimals);
}
