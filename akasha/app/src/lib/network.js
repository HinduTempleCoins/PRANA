// network.js — the ONE place the public Akasha build learns which chain it is on.
//
// PRANA mainnet only. The alpha chain (108369) is retired; nothing in the public
// build may point at it. Every transaction the wallet signs carries CHAIN_ID
// (EIP-155 replay protection), and the wallet refuses to sign if the RPC reports
// a different chain id (see assertChainId in WalletView).

export const CHAIN_ID = 712217;
export const CHAIN_ID_HEX = '0xade19';
export const CHAIN_NAME = 'PRANA';
export const NATIVE_SYMBOL = 'PRANA';
export const RPC_URL = 'https://rpc.prana.melek.salon';
export const EXPLORER_URL = 'https://pranascan.soapbox.community';
export const KULASWAP_URL = 'https://kula.money';
export const SIGNER_URL = 'https://signer.melek.salon';

// Mainnet ERC-20 list. Decimals verified on-chain (decimals()) 2026-10-18.
// `swap` = the KulaSwap ?in=&out= pair for a "Swap" link (KulaSwap lists WPRANA,
// not native PRANA; wMELEK has no KulaSwap pool yet, so no link).
export const TOKENS = [
  { symbol: 'KULA', name: 'KULA', address: '0x32255D0138f5D645894FA89b5D5B5a68cF9Aa631', decimals: 18, swap: ['KULA', 'WPRANA'] },
  { symbol: 'WPRANA', name: 'Wrapped PRANA', address: '0xCAbCaAeBBF7a7312b91A92Faa635d7a32Af42a34', decimals: 18, swap: ['WPRANA', 'KULA'] },
  { symbol: 'wVKBT', name: 'Wrapped VKBT', address: '0xD915E757662c4234137aff167Bf93d588145f75e', decimals: 8, swap: ['wVKBT', 'WPRANA'] },
  { symbol: 'wCURE', name: 'Wrapped CURE', address: '0x03d613BDaAd82ecd6cf36B0fEf88Fb6AF9d977Ff', decimals: 8, swap: ['wCURE', 'WPRANA'] },
  { symbol: 'wMELEK', name: 'Wrapped MELEK', address: '0xf6d9BE2859191b45820Df3A3B3b321b1b2589AB9', decimals: 18, swap: null },
];
export const NATIVE_SWAP = ['WPRANA', 'KULA'];

// Publicly-known development keys (Anvil/Hardhat mnemonic "test test ... junk").
// Anything sent to these on a live chain is swept by bots within seconds. Older
// dev builds of Akasha offered a one-click import of #0, so a returning browser
// may still hold it — the wallet flags these and never offers them as "receive".
export const PUBLIC_TEST_ADDRESSES = new Set(
  [
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
    '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
    '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
    '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  ].map((a) => a.toLowerCase()),
);

export function isPublicTestAddress(addr) {
  return typeof addr === 'string' && PUBLIC_TEST_ADDRESSES.has(addr.toLowerCase());
}

export function kulaSwapLink(inSym = 'WPRANA', outSym = 'KULA') {
  const q = new URLSearchParams({ in: inSym, out: outSym });
  return `${KULASWAP_URL}/?${q.toString()}`;
}
