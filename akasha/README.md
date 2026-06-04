# Akasha Wallet — key-management core

Private (gitignored) workspace for the Akasha wallet, the user-facing gateway to the
PRANA chain. This directory holds the wallet's **key-management core**: plain JavaScript
ESM modules with no framework, built directly on **ethers v6** crypto (resolved via the
`lib/node_modules` symlink to `../contracts/node_modules`).

## What exists now (Q1 + Q2)

### `lib/keyvault.mjs` — BIP-39/32/44 HD key vault
A single hierarchical-deterministic seed and the accounts derived from it.

- `createVault(password, { wordCount, scrypt, accountCount })` → `{ vault, mnemonic }`
  Generates a fresh mnemonic (`ethers.Mnemonic.fromEntropy` over `randomBytes`). The
  **mnemonic phrase is returned exactly once** for the user to back up and is never stored
  in plaintext or retained on the vault object.
- `importFromMnemonic(phrase, password, opts)` → `{ vault, mnemonic }` — rebuild from an
  existing phrase (BIP-39 checksum validated).
- `unlockVault(vaultFileOrCryptoString, password)` → live `Vault` (throws on wrong password).
- `deriveAccount(vault, index)` → `{ address, path, index }` on `m/44'/60'/0'/0/index`.
- `signerFor(vault, index, provider?)` → ethers `HDNodeWallet` (optionally provider-connected).
  **This is the only path by which usable key material leaves the module.**
- `exportMnemonic(vault, password)` → phrase — requires the password again (re-auth) even
  when the vault is already unlocked.
- `serializeVault(vault)` → the persistable file object.

**Vault file format**

```jsonc
{
  "version": 1,
  "crypto": "<ethers keystore JSON string>",   // scrypt + AES; stores the mnemonic entropy
  "meta": { "createdAt": "...", "accounts": [{ "index": 0, "address": "0x..." }], "hdPath": "m/44'/60'/0'/0" }
}
```

### `lib/keystore.mjs` — multi-entry, password-locked store
Manages many entries: HD vaults **and** imported single private keys.

- `addVault({ mnemonic | vaultFile, label })`, `addImportedKey(privateKey, { label })`
- `list()` (non-secret), `get(id, provider?)` (decrypts → mnemonic/signer or privkey/signer),
  `remove(id)`
- `changePassword(oldPw, newPw)` — re-encrypts **every** entry; the old password stops
  working afterward.
- `unlock(password)` / `lock()` — in-memory session. Auto-locks after an idle timeout
  (`autoLockMs`, default 5 min). The clock is injectable (`opts.clock`) for deterministic
  tests.
- Persistence via an injectable `storage` interface (`saveBlob` / `loadBlob`).

Each entry's secret is an **independent** ethers keystore JSON encrypted under the master
password — there is no separate master key; the password is the key, applied per entry.

### `lib/storage-fs.mjs` — storage backends
- `createFsStorage(filePath)` — Node fs impl, **atomic writes** (temp + rename), mode `0600`.
- `createMemoryStorage(initial?)` — in-memory impl for tests/ephemeral sessions.

The storage interface is deliberately tiny (`saveBlob(string)` / `loadBlob() → string|null`)
so a browser `localStorage` impl can be dropped in later without touching the keystore.

## Security notes

- **Keys never leave a module in plaintext** except deliberately via `signerFor(...)` (an
  ethers signer) or `get(...)` / `exportMnemonic(...)`, which are the explicit "use the key"
  / "reveal the seed" actions.
- **Mnemonic is shown once.** After `createVault` / `importFromMnemonic` return it, the
  phrase only ever lives encrypted at rest. Re-revealing requires the password.
- **At-rest crypto is ethers' keystore** (scrypt KDF + AES-128-CTR). We never hand-roll AES,
  scrypt, or the RNG. Production uses ethers' default scrypt cost (N = 2¹⁸); tests pass a
  cheap `{ N: 1024, r: 8, p: 1 }` override so the suite stays fast.
- **Wrong password** is rejected by ethers (`"incorrect password"`); the keystore verifies a
  password on `unlock()` by decrypting the first entry.
- **`lock()` nulls references** (the BIP-32 root, the held password) so secret material
  becomes GC-eligible.
  **Residual-memory caveat (honest):** JavaScript provides no guaranteed memory wipe.
  Strings are immutable and may persist in the heap until garbage-collected, and decrypted
  buffers may linger. `lock()` minimizes the window but cannot guarantee erasure. A
  hardened build would need native secure-memory primitives outside plain JS.
- Secrets are **never logged**.

## Tests

`node --test akasha/test/keyvault.test.mjs akasha/test/keystore.test.mjs`

Covers: create/import/unlock round-trips, wrong-password rejection, deterministic
derivation against the canonical `test … junk` mnemonic (asserts the known first address
`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`), single-key import, `changePassword`
re-encryption (old password fails after), and auto-lock firing via a fake clock.

## Expected next (Q3 / Q4)

- **Q3** — transaction layer: build/sign/serialize PRANA transactions (EIP-1559 + legacy),
  nonce management, gas estimation against PRANA RPC, and a provider wired to chain ID
  `108369`.
- **Q4** — account/session UX layer: address book, multiple named accounts per vault,
  connection/permission model for the dapp browser (EIP-1193 provider surface), and the
  browser `localStorage` storage impl.
