import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Akasha wallet/explorer — Vite + React, private local-only dev app.
// The wallet core lives in akasha/lib/*.mjs (ethers v6); we import those modules
// directly from outside the app root, so allow Vite's dev server to read them.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: {
      // Allow importing ../lib/*.mjs and the shared theme from the repo.
      allow: ['..', '../..'],
    },
  },
});
