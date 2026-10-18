# Akasha — PRANA wallet + explorer (Vite + React)

The public, self-custody PRANA mainnet wallet (live at akasha.soapbox.community).
One Vite + React app, tabbed views (no router).

- **Chain:** PRANA mainnet · chainId `712217` (`0xade19`) — pinned in `src/lib/network.js`;
  every tx is EIP-155 signed for it and the wallet refuses to sign if the RPC reports another id.
- **RPC:** `https://rpc.prana.melek.salon` · **Explorer:** PRANAScan · **DEX:** kula.money
- **Tokens:** KULA / WPRANA / wMELEK (18 dp), wVKBT / wCURE (8 dp) — `src/lib/network.js`.
- **Tabs in the public build:** Wallet, Explorer, Network. The NFT / Mint / Market / Packs / Burn
  views are bound to alpha/fixture contracts and are not mounted until their contracts exist on 712217.

## Deploy (public build)

`npm run build` → `dist/`. The build injects a CSP `<meta>` (connect-src = the PRANA RPC only, no
third-party script/style/font/img). The web server must ALSO send, on every response:
`Content-Security-Policy` (same policy + `frame-ancestors 'none'`), `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-cache` on `index.html`.

## Quick start

```bash
npm install          # node_modules already present in the dev image
npm run dev          # http://127.0.0.1:5173
npm run build        # production bundle -> dist/
npm test             # pure-logic unit tests (node:test)
```

The app **builds and runs without a live node**. Every chain view shows a graceful
"node unreachable" banner and auto-reconnects once the node is up
(`chain/scripts/run-miner.sh`).

## The three views

1. **Wallet** — create or unlock an encrypted vault (scrypt + AES, all crypto in
   `akasha/lib/keyvault.mjs` / `keystore.mjs` via ethers v6). Create flow shows the
   12-word recovery phrase **once** and requires re-typing the last word to confirm
   backup. Account list, native balance (polled via `eth_getBalance`), and a send
   form with a **dry-run preview** (gas estimate + decoded revert reason from
   `lib/txbuilder.mjs`) before `sendAndWait`. A one-click "import DEV key" loads the
   publicly-known Anvil/Hardhat account #0 (pre-funded on the dev genesis).
2. **Explorer** — latest-blocks table (auto-refresh), block detail, and a search box
   for block number / address / tx hash. Plain `fetch` JSON-RPC, no extra deps.
3. **Network** — live node status + the `wallet_addEthereumChain` / EIP-3091
   metadata to add PRANA to any wallet.

## Architecture

- **Wallet core is reused, not re-implemented.** `src/lib/wallet.js` is a thin bridge
  that re-exports the tested modules in `akasha/lib/*.mjs` (ethers v6) — the
  documented core per the component-architecture spec — and adds a browser
  `localStorage` implementation of the keystore's `saveBlob`/`loadBlob` interface
  (the only prior impl was the Node fs one).
- **Explorer components** live in `src/components/explorer/` (`BlockList`,
  `BlockDetail`, `AddressCard`, `TxCard`) and take the RPC provider via props.
- **Pure logic** (`src/lib/format.js`, `src/lib/rpcMappers.js`) is unit-tested under
  `node:test` (`test/`).
- **Theme** (`src/styles/theme-tokens.css`) is copied verbatim, with a provenance
  comment, from `tools/brain/state/design/akasha/theme-tokens.css`.

## Security notes

- Private keys never touch React state or logs — they only flow through the `lib/`
  modules (the keystore returns an ethers signer; the key stays inside).
- The recovery phrase is shown once at creation, then dropped from memory after the
  backup-confirm step.
- `npm` installs are confined to this directory.
