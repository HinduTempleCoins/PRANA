# Akasha Signer-Boundary Audit Checklist (AK23)

> Public-repo doc. No backend hostnames, IPs, or credentials. A checklist for auditing the
> key-isolation boundary: **private keys and seed material never leave the signer module**.
> Cross-links the wallet security spec (Z8 / H1+H2, gitignored) — this is the concrete,
> reviewable boundary that spec's three-surface model rests on.

## 0. The boundary, in one sentence

There is exactly **one** module that holds decrypted key material (the **signer**: keyvault →
keystore → an in-memory ethers `Wallet`/`Signer`). Every other module — tx builders, send-flow,
bridge-initiate, mint/trade/airdrop, the React shell — receives only an **opaque signer handle**
and calls `signTransaction` / `signMessage` / `sendTransaction` on it. **No other module ever sees
a private key, a mnemonic, or the bytes of either.** The audit confirms that boundary is real and
unbreached on every path.

```
  ┌──────────────────────────────────────────┐
  │  SIGNER MODULE  (keyvault / keystore /     │  ← the ONLY place decrypted key bytes exist
  │  in-memory Wallet)                          │
  │   - decrypt-on-demand, zeroize after use    │
  │   - exposes: signTransaction, signMessage,  │
  │     sendTransaction, getAddress              │
  └───────────────┬────────────────────────────┘
                  │  opaque handle (no key bytes cross this line)
   ┌──────────────┴───────────────┬───────────────┬──────────────┐
   ▼                              ▼               ▼              ▼
 txbuilder      send-flow   bridge-initiate   mint/trade/airdrop   React shell
 (build calldata, never sign)  …  (build + hand to signer)  …  (renders, never touches keys)
```

## 1. Keys never leave the signer module

- [ ] Only the signer module (keyvault/keystore) ever holds a decrypted private key or mnemonic in
      a variable. Grep the rest of `lib/` for `privateKey`, `mnemonic`, `entropy`, `seed`,
      `0x[0-9a-f]{64}` — there must be no key material outside the signer.
- [ ] Consumer modules (`txbuilder`, `send-flow`, `bridge-initiate`, mint/trade/airdrop, deploy-
      wizard) accept a `signer`/`wallet` object and call its methods only. None reads `.privateKey`
      / `._signingKey()` / extracts the secret.
- [ ] No module returns a private key or mnemonic from any function. The signer's public surface is
      sign/send/getAddress + (encrypted) export, nothing that emits plaintext secrets.
- [ ] The EIP-1193 provider shim (`provider-1193.mjs`) signs by delegating to the signer module; it
      does not hold or pass key bytes to dapps. `eth_accounts` returns addresses only;
      `eth_sign`/`personal_sign`/`eth_sendTransaction` route through the signer.

## 2. No key in logs, errors, or telemetry

- [ ] No `console.log` / logger call anywhere can print a key, mnemonic, or full signer object.
      (Logging an ethers `Wallet` can leak fields — log `await signer.getAddress()` only.)
- [ ] Error objects thrown on the signing path carry **no** key material: no key in `err.message`,
      `err.data`, or attached context. Re-check `send-flow.mjs` / `bridge-initiate.mjs` error
      shapes (they attach `code`, `revertReason`, `hash` — never a key).
- [ ] No telemetry/analytics in the wallet transmits anything derived from the seed beyond a public
      address the user has chosen to expose. Ideally no telemetry at all; if present, it is
      address-free by default.
- [ ] Crash/exception reporters (if any) scrub the signer module's stack locals — or the signer
      runs where its locals are never serialized into a report.
- [ ] Encrypted keystore JSON is never logged even in its *encrypted* form at debug level (avoids
      ciphertext + params leaking to offline attack).

## 3. Memory zeroization

- [ ] Decrypted key material is held as a `Uint8Array`/buffer where possible and **zeroized**
      (overwritten with zeros) immediately after the signing operation, not left for GC.
- [ ] Decrypt-on-demand: the keystore decrypts for a signing op and re-locks; the plaintext key is
      not kept resident longer than necessary. A long-lived in-memory `Wallet` (for a session) is a
      documented, bounded exception with an explicit lock/timeout that drops it.
- [ ] The password/passphrase used to unlock the keystore is itself zeroized after deriving the
      scrypt/AES key; it is not retained.
- [ ] On lock / logout / session-timeout, all decrypted signers and derived secrets are dropped and
      their buffers zeroized. Verify there is a single `lock()` path that does this.
- [ ] No decrypted secret is written to disk, `localStorage`, IndexedDB, or any cache. Only the
      **encrypted** keystore (scrypt + AES-GCM, per Q2) persists.

## 4. The exact boundary the lib enforces (review anchors)

- [ ] **keyvault.mjs / keystore.mjs** — the only modules importing/holding plaintext key bytes;
      expose encrypt/decrypt/sign, never a plaintext getter.
- [ ] **txbuilder.mjs** — `buildTx`/`dryRun` are key-free (pure RPC + encoding); `signTx`/
      `sendAndWait` take an injected signer and call its methods. No key handling.
- [ ] **send-flow.mjs** — sequences simulate/send; calls `signer.signTransaction`; never inspects
      the signer's secret.
- [ ] **bridge-initiate.mjs** — builds calldata and (optionally) calls `signer.sendTransaction`;
      holds no keys; the off-chain relayer/attester path is explicitly outside the wallet and holds
      no wallet keys.
- [ ] **provider-1193.mjs** — dapp-facing; delegates signing to the signer module; exposes
      addresses, not keys.
- [ ] **React shell** — renders state + calls lib functions; imports no key material; no key in
      component props, state, Redux store, or devtools-visible state.

## 5. Process / boundary hygiene

- [ ] Client-side key generation only (keys are born in the wallet, never received from a server).
- [ ] The signer boundary is the same on every transport surface — clearnet or Tor onion
      (`tor-dual-surface-note.md`) — transport never widens it.
- [ ] Any "export" path produces only the **encrypted** keystore or an explicitly user-initiated,
      one-time, warning-gated plaintext reveal — never a silent or programmatic plaintext export.
- [ ] CI secret-scan (gitleaks, `II1`) covers the repo so no test fixture commits a real key; test
      keys are the well-known public Anvil/Hardhat keys, clearly marked DEV-ONLY.

## 6. Cross-references

- Authoritative security model (three enforcement surfaces, policy engine, key-storage tiers):
  the wallet-security-spec (Z8 = H1+H2) — gitignored; this checklist is the concrete boundary
  underneath surface (B)/(C) there.
- Key vault / keystore implementation: `akasha/lib/keyvault.mjs`, `akasha/lib/keystore.mjs`
  (BIP-39/32/44, scrypt + AES-GCM, Q1/Q2).
- Transport surface that must not widen the boundary: `design/akasha/tor-dual-surface-note.md`.
- Vanity-gen lesson (a real key-exfil class to avoid): the Profanity note (`G22`).
