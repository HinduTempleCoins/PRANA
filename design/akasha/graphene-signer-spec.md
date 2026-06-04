# Akasha — Graphene Signer Spec (AK1)

> Scope: the **Graphene-side** signer for the Akasha two-track wallet. The EVM track
> (`akasha/lib/keyvault.mjs` + ethers v6) is already built; this is its mirror for the
> Graphene chains — Hive / BLURT / and our own **MELEK** (a BLURT/Graphene fork).
>
> Headless library only (`akasha/lib/graphene-signer.mjs` + `graphene-keytiers.mjs`).
> No React here.

---

## 1. Why Graphene is different from EVM

| | EVM (ethers track) | Graphene (this track) |
|---|---|---|
| Curve | secp256k1 | secp256k1 (same curve) |
| Long-term secret | BIP-39 mnemonic → BIP-32 HD tree | a single **master password** string |
| Key derivation | BIP-32 `m/44'/60'/0'/0/i` | `sha256(account + role + password)` |
| # of keys per account | one per HD index | exactly **4 role keys** (owner/active/posting/memo) |
| Private-key text format | `0x`-hex | **WIF** (base58check, `0x80` version) |
| Public identity | 20-byte keccak address | `PREFIX`-base58 public-key string (ripemd160 checksum) |
| Account name | (the address) | a human handle registered on-chain (e.g. `alice`) |

The curve is identical, so we reuse the same `@noble/secp256k1` primitive the EVM side's
ethers dependency uses under the hood. **Everything that differs is encoding + the KDF**,
not the cryptography.

---

## 2. The Graphene key model (verified)

The canonical Graphene "suggest a brain-key from a password" derivation (Steem/Hive/BLURT,
`steemit/libcrypto-js`, `graphenejs`, `beem`):

```
seed       = account_name + role + master_password        // string concat, no separators
secret     = sha256( utf8(seed) )                          // 32 bytes
privateKey = secp256k1 private key = secret                // used directly as the scalar d
```

- `role ∈ { "owner", "active", "posting", "memo" }`.
- The master password is an arbitrary string. Wallets conventionally generate a strong one
  prefixed `P` + base58(random) (so it *looks* like a WIF), but the KDF treats it as opaque
  bytes — any string works. We mirror that: we accept any non-empty password and, for
  *generating* a fresh one, emit the conventional `P`+base58 shape.
- Source: GitHub `steemit/libcrypto-js`, Hive `@noisy` "generate all keys from master
  password offline", `@bitcoinsig` "derive private keys from a brainwallet in Graphene".

> ⚠️ Note vs EVM: there is **no per-index HD tree**. An account has four keys, full stop.
> "More accounts" = more `(account, password)` pairs, not more derivation indices.

### WIF (private-key text encoding)
```
payload  = 0x80 || privKey(32)
checksum = sha256(sha256(payload))[0:4]
WIF      = base58( payload || checksum )
```
(Identical to Bitcoin mainnet uncompressed WIF — Graphene keys are stored uncompressed-WIF
even though the *public* key is published compressed.)

### Public-key string (the published identity)
```
pub        = secp256k1 compressed public key (33 bytes)
checksum   = ripemd160( pub )[0:4]        // NB: ripemd160, NOT double-sha256
pubKeyStr  = PREFIX + base58( pub || checksum )
```
`PREFIX` is the chain's address prefix: `STM` (Steem/Hive historically used `STM`),
`BLURT`, and for us **`MELEK`** (configurable — see §5). This string is what shows up as
the account's `owner`/`active`/`posting`/`memo` authority and `memo_key` on-chain.

---

## 3. How it mirrors the EVM signer

The EVM track exposes (keyvault.mjs): `signerFor()` → an ethers signer with
`.address`, `.signMessage()`, `.signTransaction()`. The Graphene signer mirrors the same
*shape* with Graphene-native verbs:

| EVM (ethers) | Graphene mirror | notes |
|---|---|---|
| `signerFor(vault, i)` | `signerFor(account, role, password)` | returns a `GrapheneSigner` |
| `signer.address` | `signer.getPublicWif()` / `signer.getAddress()` | `getAddress()` = the `PREFIX…` pubkey string (identity); `getPublicWif()` = same string. |
| `signer.signMessage(m)` | `signer.signDigest(d)` / `signer.signMessage(m)` | Graphene signs a 32-byte **digest** (sha256 of the serialized tx); `signMessage` sha256s first. |
| ethers `verifyMessage` | `verify(digest, sigHex, pubKeyStr)` | static, recovers/checks the compact recoverable sig. |
| `exportMnemonic(vault, pw)` | `exportWif(account, role, password)` | re-derive + emit WIF. |

The signer is **transaction-shape-agnostic on purpose**: Graphene tx serialization
(the bytes that get sha256'd into the digest) is a *separate* concern owned by the chosen
client lib (dhive/hive-tx). This module's job is exactly the signer boundary: turn
`(account, role, password)` into keys, sign a digest, verify, and expose the public
identity — nothing about RPC, broadcast, or tx encoding.

---

## 4. Signer boundary (keys never leave the module)

Same discipline as keyvault.mjs:

- Private keys (the 32-byte scalars) are held **only inside a `GrapheneSigner` instance**,
  in a closed-over `#priv` field, and are never returned by any getter. The only way a
  private key leaves is the explicit, password-gated `exportWif()` (privileged action,
  mirrors `exportMnemonic`).
- The master password is consumed to derive keys and **not retained** on the signer object.
- `signer.wipe()` nulls the private scalar (best-effort; JS gives no guaranteed zeroization —
  documented caveat, same as keyvault's `lock()`).
- Getters expose only public material: the `PREFIX…` pubkey string.

---

## 5. Library choice & swappability (the AK4 gate)

**Decision AK4 is gated** (dhive vs hive-tx vs @graphene vs in-house). We do not pick the
broadcast/tx-build client here. Instead:

- **Default (shipped now): a minimal in-house secp256k1 path** using
  `@noble/secp256k1` (already a transitive dep, v1.7.1, present in the shared
  `contracts/node_modules`), `@noble/hashes` (sha256 / ripemd160 / hmac), and
  `@scure/base` (base58). These are the same audited `noble`/`scure` libraries ethers v6
  bundles, so we add **zero new dependencies** for the crypto core.
- **Swappable adapter:** all curve/hash/encoding ops go through a single
  `cryptoAdapter` object (`{ derivePriv, getPublicKey, signRecoverable, verify, sha256,
  ripemd160, base58 }`). The default adapter is `nobleAdapter`. To later route signing
  through dhive/hive-tx (e.g. to reuse their tx serializer), implement the same adapter
  interface and pass it in — **the signer/keytier logic does not change.**
- **Why not hard-depend on dhive/hive-tx now:** they pull a large dependency tree
  (bytebuffer, secure-random, bs58, etc.) and bake in chain config; the in-house path keeps
  the headless lib tiny and test-deterministic. They become attractive only once we need
  full tx *serialization*, which is out of scope for the signer.

**Dep to add: NONE.** If a future task needs Graphene tx serialization, add **`hive-tx`**
(lighter than dhive, no full RPC client) — document, don't auto-install.

---

## 6. Test plan (graphene-signer.test.mjs — node:test)

- **Known-vector determinism:** `(account, role, password)` → fixed private scalar / WIF /
  pubkey string, asserted byte-for-byte (self-consistent vector generated from the verified
  algorithm; if an external Graphene vector is citable it is added).
- **Round-trip sign/verify** of a 32-byte digest; deterministic (RFC-6979) signatures.
- **Tier derivation:** `deriveAllTiers(account, password)` yields 4 distinct keys; each role
  matches `signerFor(account, role, password)`.
- **Wrong-password → different key:** changing one char of the password changes every
  derived key.
- **Boundary:** no getter returns the private scalar; `exportWif` does (gated).
- All timers (none expected) `unref`'d; no open handles.

---

## 7. Files

- `akasha/lib/graphene-signer.mjs` — the signer (AK2).
- `akasha/lib/graphene-keytiers.mjs` — the owner/active/posting/memo tier model (AK3).
- `akasha/lib/graphene-signer.test.mjs` — node:test suite.
