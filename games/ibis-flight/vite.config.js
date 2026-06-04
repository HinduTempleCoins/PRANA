import { defineConfig } from 'vite';

// Dual build (mirrors games/naga).
// `--mode crypto`  -> CRYPTO_BUILD = true  (score-voucher rails + attester POST + crypto UI strings)
// `--mode clean`   -> CRYPTO_BUILD = false (clean funnel: settlement is a no-op, NO crypto strings)
// Default `vite build` (no mode) falls back to clean, the safest public funnel.
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
