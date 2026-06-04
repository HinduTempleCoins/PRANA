# Akasha over Tor — Dual-Surface Testing Note (AK22)

> Public-repo doc. No backend hostnames, IPs, or operator credentials. This is a *testing*
> note: how to run and exercise the wallet across a clearnet + onion (dual) surface, and the
> caveats that change when RPC rides over Tor.

## 0. What "dual surface" means here

The wallet should be reachable and functional on **both**:

- **clearnet** — the normal `https://` front-end + a public/clearnet RPC endpoint, and
- **onion** — the same front-end served as a Tor hidden service (`.onion`), optionally talking to
  an RPC node also published as a hidden service.

"Dual surface" = one build that works on either, selected by configuration, so a privacy-conscious
user can run the entire wallet → RPC → (optionally) explorer path without leaving Tor, while a
default user stays on clearnet. The **signer/key layer is identical on both surfaces** — Tor
changes the *transport*, never the key isolation boundary (see
`signer-boundary-audit-checklist.md`).

## 1. What changes when RPC rides over Tor

Tor only moves bytes; the JSON-RPC semantics are unchanged. But the transport characteristics
differ enough to matter for the wallet's tx-building and watching code:

- **Latency & jitter:** Tor circuits add seconds of latency and high variance. Every RPC-driven
  timeout in the libs must be generous and configurable, not hard-coded for a LAN node. Affected:
  `txbuilder.sendAndWait` (`pollMs`/`timeoutMs`), `bridge-initiate.watchCompletion`
  (`pollMs`/`timeoutMs`), and any balance/nonce polling. **Test with an injected slow provider**
  (artificial delay) to confirm nothing assumes sub-second RPC.
- **Connection resets / circuit changes:** a Tor circuit can drop mid-request. RPC calls must be
  **retryable and idempotent-safe**. Reads (balance, nonce, getLogs) retry freely. For a *send*,
  retry must be guarded: re-broadcasting the *same signed tx* is safe (same hash, mempool dedups);
  re-*building* a tx after a reset must reuse the same nonce or it risks a double-spend of intent.
  This is the same nonce-conflict guard `send-flow.mjs` already enforces — verify it survives a
  mid-send transport reset.
- **No DNS, no leaks:** when on the onion surface, the front-end must make **zero** requests to
  clearnet hosts (analytics, fonts, price APIs, default public RPC). A single clearnet fetch from
  an onion page deanonymizes the user. Test by running the onion surface with clearnet egress
  blocked and asserting the wallet still fully functions (fixture/price-cache fallbacks must cover
  every external call). Price/metadata adapters must have an offline/fixture mode (they already do
  — `W2`/`W3` cached fixtures).
- **WebSocket vs HTTP RPC:** long-lived WS subscriptions over Tor are fragile. On the onion
  surface, prefer **HTTP polling** (`getLogs` loops) over `eth_subscribe`. `watchCompletion`
  already supports a polling path — exercise the polling branch, not the subscribe branch, in Tor
  tests.

## 2. Caveats / sharp edges (RPC-over-Tor)

- **Exit-node hostility (clearnet RPC via Tor):** if the onion front-end talks to a *clearnet* RPC
  through a Tor exit, a malicious exit can see and tamper with RPC responses (it cannot forge
  signatures, but it can lie about balances, gas prices, or swallow a broadcast). Mitigation:
  prefer an **onion-published RPC** (end-to-end inside Tor, no exit), and treat clearnet-RPC-over-
  Tor as untrusted — cross-check critical reads (e.g. confirm a broadcast by polling receipt, do
  not trust a single "sent" ack). Never derive security from RPC response content; the chain state
  is confirmed by receipts, and signatures are produced locally regardless.
- **Time:** Tor clients sometimes have skewed clocks; do not gate any wallet logic on local
  wall-clock vs chain time beyond generous tolerances.
- **Fingerprinting:** keep the onion build byte-identical to clearnet except for the configured
  endpoints, so the two surfaces are not distinguishable by asset hashes.

## 3. Test matrix

| Case | Surface | RPC | Assert |
|---|---|---|---|
| Baseline | clearnet | clearnet HTTP | full flow works (existing tests) |
| Slow transport | either | injected-delay provider | no hard timeout fires; send/watch complete |
| Mid-send reset | either | provider that throws once then recovers | retry is safe; no double nonce |
| Onion isolation | onion | onion RPC, clearnet egress blocked | zero clearnet fetches; wallet fully functional via fixtures |
| Hostile exit | onion page | clearnet RPC via Tor exit | broadcast verified by receipt poll, not by the "sent" ack |
| Poll vs subscribe | onion | onion RPC | `watchCompletion` uses the polling branch and finds the event |

These run headless against mock/fixture providers (same style as `bridge-initiate.test.mjs` and
`send-flow.test.mjs`) — the "Tor" condition is simulated by an injected provider with added
latency / one-shot failures. No live Tor daemon is needed for the unit layer; an end-to-end onion
bring-up is a manual ops step (out of scope for this public note).

## 4. Cross-references

- Signer isolation (unchanged by transport): `design/akasha/signer-boundary-audit-checklist.md`.
- RPC timeouts/retries that must be Tor-tolerant: `akasha/lib/txbuilder.mjs`,
  `akasha/lib/bridge-initiate.mjs`, `akasha/lib/send-flow.mjs`.
- Offline price/metadata fallbacks: the API adapters (`W2`/`W3`) fixture modes.
- Network-privacy background: the Dandelion++/Tor research note (`G21`).
