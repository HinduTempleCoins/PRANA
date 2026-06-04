# Akasha — PRANA wallet + explorer (Vite + React)

A private, local-only dev app: the consumer-facing gateway to the PRANA chain.
One Vite + React app, three tabbed views (no router).

- **Chain:** PRANA · chainId `108369` (`0x1a751`)
- **RPC:** `http://127.0.0.1:8545` (the local core-geth dev node)
- **Scope:** local dev only. The "DEV WALLET" badge is shown everywhere — never
  store real value here.

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
