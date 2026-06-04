// PRANA / Akasha — message + EIP-712 typed-data signing helpers.
// Used for dApp logins / HiveSigner-style challenge-response: a server issues a
// challenge (plain string or typed-data payload), the wallet signs it, and the
// server verifies the signature recovers to the expected address. Offline, viem v2.

import { verifyMessage, verifyTypedData } from 'viem';

// Sign a plain string message with a viem account.
export async function signMessage(account, message) {
  return account.signMessage({ message });
}

// Verify a plain-message signature recovers to `address`.
export async function verifyMsg(address, message, signature) {
  return verifyMessage({ address, message, signature });
}

// Sign an EIP-712 typed-data payload ({ domain, types, primaryType, message }).
export async function signTyped(account, typedData) {
  return account.signTypedData(typedData);
}

// Verify a typed-data signature recovers to `address`.
export async function verifyTyped(address, typedData, signature) {
  return verifyTypedData({ ...typedData, address, signature });
}
