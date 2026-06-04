import { defineConfig } from 'vite';

// Dual build (mirrors games/tower-defense).
// `--mode crypto`  -> CRYPTO_BUILD = true  (settlement rails / runVoucher enabled)
// `--mode clean`   -> CRYPTO_BUILD = false (clean funnel: voucher poster is a no-op, NO
//                                           crypto/wallet/voucher strings in the bundle)
// Default `vite build` (no mode) falls back to clean, the safest public funnel.
//
// __CRYPTO_BUILD__ is inlined as a build-time literal so the bundler can dead-code-eliminate
// the entire settlement path (src/data/runVoucher.js) from the clean build.
export default defineConfig(({ mode }) => {
  const cryptoBuild = mode === 'crypto';
  return {
    root: '.',
    base: './',
    define: {
      __CRYPTO_BUILD__: JSON.stringify(cryptoBuild),
    },
    build: {
      outDir: cryptoBuild ? 'dist-crypto' : 'dist-clean',
      emptyOutDir: true,
    },
  };
});
