// txsigner.js — build + sign EIP-1559 transactions offline for PRANA.
//
// Offline-only: no RPC calls. Callers supply nonce/gas explicitly. The signed
// serialized transaction can be broadcast later via any node's eth_sendRawTransaction.

import { privateKeyToAccount } from 'viem/accounts';
import { parseEther, parseGwei } from 'viem';

const PRANA_CHAIN_ID = 108369;

/**
 * Build the unsigned EIP-1559 transaction request object (for preview/simulation).
 *
 * @param {object} params
 * @param {`0x${string}`} params.to                    recipient address
 * @param {string|number} params.valueEth              amount in PRANA (ether units)
 * @param {number|bigint} params.nonce                 sender nonce
 * @param {number} [params.chainId=108369]             PRANA chain id
 * @param {string} [params.maxFeePerGasGwei='2']       max fee per gas, in gwei
 * @param {string} [params.maxPriorityFeePerGasGwei='1'] max priority fee per gas, in gwei
 * @param {bigint} [params.gas=21000n]                 gas limit
 * @returns {object} unsigned eip1559 tx request
 */
export function buildTransfer({
  to,
  valueEth,
  nonce,
  chainId = PRANA_CHAIN_ID,
  maxFeePerGasGwei = '2',
  maxPriorityFeePerGasGwei = '1',
  gas = 21000n,
}) {
  return {
    type: 'eip1559',
    to,
    value: parseEther(String(valueEth)),
    nonce: Number(nonce),
    chainId,
    maxFeePerGas: parseGwei(String(maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(maxPriorityFeePerGasGwei)),
    gas,
  };
}

/**
 * Build and sign an EIP-1559 transfer offline, returning the signed serialized tx.
 *
 * @param {object} params
 * @param {`0x${string}`} params.privateKey            signer private key
 * @param {`0x${string}`} params.to                    recipient address
 * @param {string|number} params.valueEth              amount in PRANA (ether units)
 * @param {number|bigint} params.nonce                 sender nonce
 * @param {number} [params.chainId=108369]
 * @param {string} [params.maxFeePerGasGwei='2']
 * @param {string} [params.maxPriorityFeePerGasGwei='1']
 * @param {bigint} [params.gas=21000n]
 * @returns {Promise<`0x${string}`>} signed serialized transaction
 */
export async function signTransfer({
  privateKey,
  to,
  valueEth,
  nonce,
  chainId = PRANA_CHAIN_ID,
  maxFeePerGasGwei = '2',
  maxPriorityFeePerGasGwei = '1',
  gas = 21000n,
}) {
  const account = privateKeyToAccount(privateKey);
  const tx = buildTransfer({
    to,
    valueEth,
    nonce,
    chainId,
    maxFeePerGasGwei,
    maxPriorityFeePerGasGwei,
    gas,
  });
  return account.signTransaction({ ...tx, type: 'eip1559' });
}
