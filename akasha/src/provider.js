import { createPublicClient, createWalletClient, http, defineChain } from 'viem';

export const pranaChain = defineChain({
  id: 108369,
  name: 'PRANA',
  nativeCurrency: { name: 'PRANA', symbol: 'PRANA', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
});

export function publicClient(rpcUrl) {
  return createPublicClient({ chain: pranaChain, transport: http(rpcUrl) });
}

export function walletClient(account, rpcUrl) {
  return createWalletClient({ account, chain: pranaChain, transport: http(rpcUrl) });
}

export function chainConfig() {
  return {
    id: 108369,
    name: 'PRANA',
    nativeCurrency: { name: 'PRANA', symbol: 'PRANA', decimals: 18 },
    rpcUrls: {
      default: { http: ['http://127.0.0.1:8545'] },
    },
  };
}
