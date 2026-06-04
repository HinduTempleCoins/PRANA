# Akasha Unified Identity Spec (AK5) — one identity across EVM + Graphene

> Implementation-ready spec for **one Akasha identity** (Phantom-style) that spans
> both signing tracks of the VKFRI ecosystem:
> - **EVM track** — PRANA (the value/compute L1). Keys from `akasha/lib/keyvault.mjs`
>   (BIP-39/32/44 over ethers v6).
> - **Graphene track** — MELEK / SOAP (Hive/BLURT-lineage social chains). Keys from
>   `akasha/lib/graphene-signer.mjs` (AK2 — the four WIF role tiers: posting / active /
>   owner / memo).
>
> The identity layer (`akasha/lib/identity.mjs`, AK6) is the headless object that
> **composes** those two existing key modules — it does NOT re-derive keys. It presents a
> single profile and answers "who am I on each chain?" so the rest of the wallet/UI never
> has to know which track a given chain uses.
>
> Cross-refs: `component-architecture.md` (Akasha 3-pillar app), the private
> `wallet-security-spec.md` (Z8 — posting-vs-active rule #2), AK1 `graphene-signer-spec.md`.

---

## 0. The goal in one line

> A user creates **one** Akasha identity (one master secret, one password). From that single
> unlock they can act as themselves on PRANA (EVM) **and** on MELEK/SOAP (Graphene), and the
> wallet shows it as a single profile. The user "never thinks about which chain a thing lives
> on" — the identity object routes each signing request to the correct track.

This is the **Phantom benchmark**: Phantom is one seed presenting Solana + Ethereum + Bitcoin
accounts under one profile. Akasha does the same across PRANA (EVM) + MELEK/SOAP (Graphene).

---

## 1. The two tracks have different key models — we bridge them, we don't merge them

| | EVM track (PRANA) | Graphene track (MELEK / SOAP) |
|---|---|---|
| Module | `keyvault.mjs` (`Vault`) | `graphene-signer.mjs` (AK2) |
| Crypto | secp256k1, Keccak addresses | secp256k1, Graphene WIF + `STM/MLK`-prefixed pubkeys |
| Derivation | BIP-32/44 HD tree `m/44'/60'/0'/0/i` | Graphene `getPrivateKeys(account, masterPw, roles)` — a per-role `sha256(account + role + masterPw)` brain-key seed |
| Account id | one address per HD index | one **named account** with **four role keys** (posting/active/owner/memo) |
| Signing unit | a tx (legacy / EIP-1559) | an **operation** (`vote`, `comment`, `custom_json`, `transfer`, `account_update`) inside a Graphene tx |
| Auth scope | full key signs anything | **role-gated**: posting ≠ active ≠ owner (login = posting only) |

They are **not** the same kind of object, so the identity layer does not try to derive one
from the other cryptographically. It **links** them under one logical identity (see §2) and
**routes** each request to the right backend (see §4).

---

## 2. The unified identity: derivation tree + linkage

### 2.1 One master input → two deterministic subtrees

An Akasha identity is seeded from **one master secret**. Two supported master shapes:

- **`mnemonic` master (recommended):** a BIP-39 mnemonic is the EVM seed directly (existing
  `keyvault` path). The Graphene **master password** is derived from that same mnemonic via a
  domain-separated KDF so the two tracks share one root of trust:
  `grapheneMasterPw = base58( sha256( "akasha-graphene-v1" || mnemonicEntropy || grapheneAccountName ) )`.
- **`password` master:** a single high-entropy passphrase. EVM seed = BIP-39 mnemonic derived
  from `sha256("akasha-evm-v1" || passphrase)` entropy; Graphene master password derived from
  `sha256("akasha-graphene-v1" || passphrase || account)`. (Lower assurance — flagged in UI.)

Both shapes give **deterministic** results: same master input ⇒ same EVM address ⇒ same
Graphene role keys, every time, on any device.

```
                    Akasha master secret  (mnemonic OR passphrase)
                                │
            ┌───────────────────┴───────────────────┐
            ▼ (existing keyvault, unchanged)         ▼ (domain-separated KDF)
   EVM seed = BIP-39 entropy                Graphene master password
            │                                        │
   m/44'/60'/0'/0/0  (default EVM acct)      getPrivateKeys(account, masterPw)
   m/44'/60'/0'/0/i  (more EVM accts)                 │
            │                          ┌──────┬───────┼────────┬───────┐
            ▼                          ▼      ▼       ▼        ▼       ▼
       evmAddress                   posting active  owner    memo  (WIF role keys)
```

**Domain separation (`"akasha-evm-v1"` vs `"akasha-graphene-v1"`)** guarantees the EVM seed and
the Graphene master password are independent secrets even though both flow from one master — a
leak of the derived Graphene master password does not reveal the EVM seed, and vice-versa.

### 2.2 Linkage model: one profile → N chain accounts

A single identity holds:

- exactly **one** primary EVM account (HD index 0; more can be linked as additional EVM
  accounts under the same identity), and
- exactly **one** Graphene **account name** (e.g. `alice`), which itself carries the four role
  keys.

The link is **by-identity, not by-cryptographic-derivation**: the profile records `{ evm,
graphene }` as two faces of the same person. Default pairing is deterministic — EVM index 0 ↔
the identity's Graphene account — so re-deriving the identity always reconstitutes the same
pairing without stored state.

```
            Akasha Identity  { label: "Alice" }
            ├── evm:      0xAbC…   (PRANA)            ← keyvault index 0
            └── graphene: "alice"  (MELEK, SOAP)      ← graphene-signer account
                          ├ posting  MLK7…
                          ├ active   MLK6…
                          ├ owner     MLK5…
                          └ memo      MLK4…
```

---

## 3. Export / lock semantics

- **Unlock** is per-identity: one password unlock materializes BOTH the live EVM vault root
  AND the live Graphene role keys in memory. The user types one password.
- **Lock** zeroizes **both** tracks: it calls `vault.lock()` (drops the BIP-32 root) AND
  `grapheneSigner.lock()` (drops the WIF role keys). After lock, neither `evmAddress()` signing
  nor `grapheneAccounts()` signing is possible without a fresh unlock. (Public addresses/pubkeys
  may still be displayed from cached non-secret metadata — see §5 privacy note; only signing is
  gated.)
- **Export is re-auth'd and per-track, never bulk.** Revealing secrets requires the password
  again even on an unlocked identity (defence-in-depth, mirroring `keyvault.exportMnemonic`):
  - `exportEvmMnemonic(password)` → the BIP-39 phrase (the EVM seed + the Graphene master root).
  - `exportGrapheneKey(role, password)` → a single WIF role key.
  There is intentionally **no** "export everything" call — each privileged reveal is explicit.
- **Owner-key handling:** the Graphene `owner` key can re-key the whole Graphene account. It is
  derivable but the identity layer treats it as cold: `resolveSignerFor` never routes ordinary
  ops to `owner`, and login (§4) yields **posting scope only** (wallet-security rule #2).

---

## 4. Signing always routes to the correct track per chain

The identity exposes a single `resolveSignerFor(chain)` (AK6). The chain→track map:

| chain id (logical) | track | what `resolveSignerFor` returns |
|---|---|---|
| `prana` | EVM | an **ethers signer** (`keyvault.signerFor(vault, index, provider)`) |
| `melek` | Graphene | a **Graphene op-signer** bound to this identity's account (role-gated `signOp`) |
| `soap`  | Graphene | same Graphene op-signer (SOAP shares the Graphene track) |

The two reconciled login paths that produce one session:

- **"Sign in with MELEK"** (HiveAuth-style, from AK2 `buildAuthChallenge`/`verifyAuthChallenge`):
  a challenge/response handshake signed by the **posting** key — never active/owner. Produces a
  Graphene-scoped session.
- **EVM wallet-connect** (`provider-1193.mjs` `eth_requestAccounts`): exposes the EVM account to
  a dapp.

`unifiedSession()` = one unlock that satisfies both: after a single password unlock, a
"Sign in with MELEK" challenge can be answered AND `eth_requestAccounts` can resolve, with no
second prompt. The identity is the join point.

**Invariant — no cross-track signer fabrication.** A Graphene-only login (the user logged in
via MELEK posting-key challenge but never unlocked/linked an EVM account) **cannot** produce an
EVM signer, and vice-versa. `resolveSignerFor('prana')` throws if no EVM account is linked;
`resolveSignerFor('melek')` throws if no Graphene account is linked. (Tested in AK6.)

---

## 5. Privacy note — these two chain identities are LINKABLE BY DESIGN

This is the one property to call out loudly:

> Under this unified-identity model the user's **PRANA (EVM) address and their MELEK/SOAP
> (Graphene) account are linkable** — they are presented as one profile and (by default)
> deterministically paired from one master secret. Anyone who learns both faces, or who watches
> the wallet present them together, can correlate "this EVM address == this MELEK account".

Why we accept it: the product goal is a *single* Phantom-style identity — convenience and a
coherent "this is me everywhere" UX. That is fundamentally a linkage feature, not a bug.

But it is a **deanonymization surface** (cross-ref `H5 deanonymization` doc): a user who wants
their social (MELEK) life unlinked from their on-chain (PRANA) finances must NOT use one unified
identity for both. Mitigations the wallet should offer:

- **Separate identities:** support creating a *second, unlinked* Akasha identity from a
  different master secret for the personas a user wants kept apart. The identity object is
  per-master, so two identities from two masters share no derivation and are not correlatable
  from key material alone (tested: different masters ⇒ different EVM + Graphene addresses).
- **No silent cross-posting:** the wallet must never auto-announce an EVM address inside a
  Graphene op (or vice-versa) without explicit user action.
- **Display the linkage:** the profile UI should make it visible that these accounts are tied,
  so the user is never surprised that they are publicly correlatable.

---

## 6. Interface the identity layer composes (AK6 contract)

`identity.mjs` is pure composition over two **injected** backends so it stays testable with
fixtures and swaps cleanly onto the real modules:

```
createIdentity({ label, evmVault, grapheneSigner, pairing })
  → MultiChainIdentity {
       label,
       evmAddress(index = 0)         // from evmVault (keyvault)
       grapheneAccounts()            // [{ account, roles:{posting,active,owner,memo pubkeys} }]
       profile()                     // { label, evm, graphene:[...] }  — non-secret, display-safe
       resolveSignerFor(chain)       // 'prana'→ethers signer; 'melek'/'soap'→graphene op-signer
       signInWithMelek(challenge)    // posting-scope HiveAuth response (delegates to grapheneSigner)
       connectEvm()                  // eth_requestAccounts-shaped { address }
       unifiedSession()              // {evm, graphene} both live after one unlock
       exportEvmMnemonic(password)   // re-auth reveal (delegates to keyvault.exportMnemonic)
       exportGrapheneKey(role, pw)   // re-auth reveal (delegates to grapheneSigner.exportKey)
       lock()                        // zeroizes BOTH tracks
       locked                        // true once either backend is locked
    }
```

- **EVM backend** = an unlocked `keyvault` `Vault` (or anything exposing `accounts`,
  `deriveAccount`/`signerFor`, `exportMnemonic`, `lock`).
- **Graphene backend** = the AK2 `graphene-signer` instance (anything exposing `account`,
  role pubkeys, `signOp(op, role)`, `signBuffer`, `verifyAuthChallenge`, `exportKey`, `lock`).

### 6.1 Interface assumption (graphene-signer not yet on disk)

At authoring time `akasha/lib/graphene-signer.mjs` (AK1-3, sibling track) was **not yet
present**. AK6 is therefore written against the **minimal documented AK2 surface** (the AK2/AK3
queue entries): a signer object with

```
{ account: "alice",
  pubkeys: { posting, active, owner, memo },   // STM/MLK-prefixed strings
  signOp(op, role),                            // role-gated; posting can't sign transfer
  signBuffer(buf, role),                       // login-challenge analog
  verifyAuthChallenge(challenge, sig),         // HiveAuth login
  exportKey(role, password),                   // re-auth WIF reveal
  lock() }
```

`identity.mjs` ships a tiny **`makeFixtureGrapheneSigner(account, masterPw)`** helper
(deterministic, secp256k1 via ethers, Graphene-shaped pubkeys) so AK6 + its tests run
standalone. When the real AK2 module lands it is injected unchanged — the helper is for
fixtures only and the contract above is what AK2 must satisfy. The one concrete coupling to
confirm with AK2 is the `pubkeys`/`signOp(op, role)`/`exportKey(role, password)`/`lock()`
shape; everything else is opaque pass-through.
