import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Akasha wallet/explorer — Vite + React, private local-only dev app.
// The wallet core lives in akasha/lib/*.mjs (ethers v6); we import those modules
// directly from outside the app root, so allow Vite's dev server to read them.
//
// Build note (mainnet copy): the lib/*.mjs files live OUTSIDE the app root and
// import bare 'ethers'. vite 8 / rolldown 1.x does not reliably resolve that bare
// specifier against app/node_modules for out-of-root importers, so we pin the
// resolution with an explicit alias + dedupe to the app's own node_modules. This
// makes ethers (and react) bundle in fully instead of being dropped.
const appNodeModules = (pkg) =>
  fileURLToPath(new URL(`./node_modules/${pkg}`, import.meta.url));

// Production CSP (build only — the dev server needs HMR websockets/inline). The
// wallet page may talk to exactly one origin: the public PRANA RPC. No third-party
// script, style, font, image or frame can load, so nothing foreign can read the
// vault or the phrase. frame-ancestors cannot be set from <meta>; it is sent as a
// response header by the web server (see app/README.md "Deploy").
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src https://rpc.prana.melek.salon",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const cspMeta = {
  name: 'akasha-csp-meta',
  apply: 'build',
  transformIndexHtml() {
    return [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
      { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
    ];
  },
};

export default defineConfig({
  plugins: [react(), cspMeta],
  resolve: {
    dedupe: ['ethers', 'react', 'react-dom'],
    alias: {
      ethers: appNodeModules('ethers'),
      react: appNodeModules('react'),
      'react-dom': appNodeModules('react-dom'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: {
      // Allow importing ../lib/*.mjs and the shared theme from the repo.
      allow: ['..', '../..'],
    },
  },
});
