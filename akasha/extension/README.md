# Akasha browser extension (MV3)

A TronLink/MetaMask-style wallet extension for the **PRANA** chain. It injects an EIP-1193 provider as
`window.ethereum` so any dapp (KulaSwap, the tokens portal, PRANAScan interactions, …) can connect and
request signatures. Keys are generated and held **client-side**, encrypted (BIP39 + scrypt+AES via the
existing `akasha/lib/keyvault.mjs`), and **never leave the device** — the page world never sees them.

## Architecture (least-privilege, TronLink pattern)

| File | World | Role |
|---|---|---|
| `inpage.js` | page MAIN | defines `window.ethereum`; relays `request()` via `postMessage`. No keys. |
| `content.js` | content (isolated) | injects inpage.js; bridges page ⇄ background. |
| `background.js` | service worker | routes methods via `request-router.mjs`: **local** answered here, **passthrough** reads → PRANA RPC, **permissioned** parked for the popup, `eth_sign` refused. Dependency-free, no keys. |
| `popup.html` / `popup.js` | extension page | unlock/create the vault (in-memory only), approve + **sign** parked requests via `wallet-core`. |
| `wallet-core.mjs` | popup | the only place that touches keys + ethers; wraps `../lib/keyvault.mjs`. |
| `request-router.mjs` | shared | pure method classification (offline-tested). |

Flow: dapp `window.ethereum.request()` → inpage → content → background. Reads are answered/forwarded
immediately; signing requests are queued, the popup opens, the user approves, the popup signs with the
unlocked vault and returns the result back through the background to the dapp.

## Build

```
cd akasha/extension
npm i -D esbuild        # if not already present from the app
node build.mjs          # → wallet-core.bundle.js (bundles ethers + keyvault for the popup)
```

`background.js` is an ESM service worker importing only the dependency-free `request-router.mjs`;
`content.js`/`inpage.js` are plain scripts — none of those need bundling.

## Load (unpacked)

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `akasha/extension/`.
3. Open the popup → **Create new** (set a password, save the 12 words) or **Unlock**.
4. Visit a PRANA dapp (e.g. KulaSwap) → it sees `window.ethereum` → **Connect**.

## Tests

```
node --test request-router.test.mjs
```

## Notes / next

- Single account (index 0) for now; multi-account is a popup-side iteration on `deriveAccount(vault, i)`.
- The full Akasha web app (`akasha/app`) remains the rich wallet; this extension is the inject-anywhere
  provider so external dapps can use Akasha keys. A Graphene/MELEK signing track (`../lib/graphene-signer.mjs`)
  can be added as a second provider surface later.
- RPC + chain are pinned to PRANA alpha (`rpc.prana.alpha.melek.salon`, chain 108369).
