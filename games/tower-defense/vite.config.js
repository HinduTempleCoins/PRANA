import { defineConfig } from 'vite';

// EE4 — dual build.
// `--mode crypto`  -> CRYPTO_BUILD = true  (wallet/NFT loader + crypto UI strings enabled)
// `--mode clean`   -> CRYPTO_BUILD = false (clean funnel: chain loader is a no-op, no
//                                           crypto/NFT/wallet strings in the UI)
// Default `vite build` (no mode) falls back to clean, the safest public funnel.
export default defineConfig(({ mode }) => {
  const cryptoBuild = mode === 'crypto';
  return {
    root: '.',
    base: './',
    define: {
      // Inlined as a literal at build time so dead-code elimination can drop the
      // chain loader entirely from the clean build.
      __CRYPTO_BUILD__: JSON.stringify(cryptoBuild),
    },
    build: {
      outDir: cryptoBuild ? 'dist-crypto' : 'dist-clean',
      emptyOutDir: true,
    },
  };
});
