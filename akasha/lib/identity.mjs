// akasha/lib/identity.mjs
//
// Akasha unified identity (AK6) — ONE identity spanning the EVM track (PRANA) and the
// Graphene track (MELEK / SOAP), Phantom-style. See design/akasha/unified-identity-spec.md.
//
// Design notes
// ------------
// * This module is PURE COMPOSITION. It never derives keys itself. It holds:
//     - an EVM backend  = an unlocked keyvault `Vault` (keyvault.mjs)
//     - a Graphene backend = an AK2 `graphene-signer` instance (graphene-signer.mjs)
//   and presents them as a single profile + a per-chain signer router.
// * Secrets never live on this object beyond what the two backends already hold. Export
//   is re-auth'd and per-track (mirrors keyvault.exportMnemonic). lock() zeroizes BOTH.
// * The two backends are INJECTED so the layer is testable with fixtures and so the real
//   AK2 graphene-signer can be swapped in unchanged once it lands.
//
// Privacy: the EVM address and the Graphene account presented by one identity are LINKABLE
// BY DESIGN (single Phantom-style profile). For unlinked personas, use TWO identities from
// two different masters. See the spec's privacy section.

import { sha256, getBytes, Wallet } from "ethers";

import {
  deriveAccount as kvDeriveAccount,
  signerFor as kvSignerFor,
  exportMnemonic as kvExportMnemonic,
} from "./keyvault.mjs";

// Logical chain ids the wallet uses, and which track each routes to.
export const CHAIN_TRACK = {
  prana: "evm",
  melek: "graphene",
  soap: "graphene",
};

// The four Graphene key roles, in privilege order (memo lowest, owner highest).
export const GRAPHENE_ROLES = ["memo", "posting", "active", "owner"];

// ---------------------------------------------------------------------------
// MultiChainIdentity
// ---------------------------------------------------------------------------

class MultiChainIdentity {
  // backends:
  //   evmVault        — unlocked keyvault Vault (or null = no EVM linked)
  //   grapheneSigner  — AK2 graphene-signer instance (or null = no Graphene linked)
  //   label           — display name
  //   pairing         — { evmIndex } default EVM account paired to the identity
  constructor({ label, evmVault = null, grapheneSigner = null, pairing = {} }) {
    this.label = label ?? "Akasha Identity";
    this._evm = evmVault;
    this._graphene = grapheneSigner;
    this._evmIndex = Number.isInteger(pairing.evmIndex) ? pairing.evmIndex : 0;
    this.locked = false;
  }

  // ---- EVM track -----------------------------------------------------------

  // The identity's EVM address (default: the paired index). Derives on-demand when
  // unlocked; falls back to the vault's cached non-secret account list when locked, so
  // a profile can still DISPLAY the address without exposing any key material.
  evmAddress(index = this._evmIndex) {
    if (!this._evm) throw new Error("no EVM account linked to this identity");
    if (this.locked) {
      const cached = this._evm.accounts?.find((a) => a.index === index);
      if (cached) return cached.address;
      throw new Error("identity is locked");
    }
    return kvDeriveAccount(this._evm, index).address;
  }

  // ---- Graphene track ------------------------------------------------------

  // The Graphene account(s) under this identity: [{ account, roles:{pubkeys} }].
  grapheneAccounts() {
    if (!this._graphene) return [];
    return [
      {
        account: this._graphene.account,
        roles: { ...(this._graphene.pubkeys ?? {}) },
      },
    ];
  }

  // ---- Unified profile (display-safe, no secrets) --------------------------

  profile() {
    return {
      label: this.label,
      evm: this._evm ? { chain: "prana", address: this.evmAddress() } : null,
      graphene: this.grapheneAccounts().map((g) => ({
        chains: ["melek", "soap"],
        account: g.account,
        roles: g.roles,
      })),
      locked: this.locked,
    };
  }

  // ---- Per-chain signer routing -------------------------------------------

  // Return the right signer for `chain`: an ethers signer for PRANA (EVM), a Graphene
  // op-signer facade for MELEK/SOAP. Throws if that track isn't linked / is locked.
  resolveSignerFor(chain, opts = {}) {
    this._requireUnlocked();
    const track = CHAIN_TRACK[chain];
    if (!track) throw new Error(`unknown chain "${chain}"`);

    if (track === "evm") {
      this._requireEvm();
      const index = Number.isInteger(opts.index) ? opts.index : this._evmIndex;
      return kvSignerFor(this._evm, index, opts.provider);
    }

    // Graphene: hand back a thin op-signer bound to this identity's account. It only
    // exposes role-gated signing; the underlying key material never leaves the signer.
    this._requireGraphene();
    const gs = this._graphene;
    return {
      chain,
      account: gs.account,
      signOp: (op, role) => gs.signOp(op, role),
      signBuffer: (buf, role) => gs.signBuffer(buf, role),
    };
  }

  // ---- Login reconciliation (one session over both tracks) -----------------

  // "Sign in with MELEK" (HiveAuth-style). Always posting-scope (rule #2): a login
  // challenge is answered by the posting key, never active/owner.
  signInWithMelek(challenge) {
    this._requireUnlocked();
    this._requireGraphene();
    const sig = this._graphene.signBuffer(challenge, "posting");
    return {
      account: this._graphene.account,
      scope: "posting",
      challenge,
      signature: sig,
    };
  }

  // EVM wallet-connect (eth_requestAccounts shape).
  connectEvm() {
    this._requireUnlocked();
    this._requireEvm();
    return { address: this.evmAddress() };
  }

  // One unlock satisfies both tracks: returns the live faces of the session.
  unifiedSession() {
    this._requireUnlocked();
    return {
      label: this.label,
      evm: this._evm ? { address: this.evmAddress() } : null,
      graphene: this._graphene
        ? { account: this._graphene.account, posting: this._graphene.pubkeys?.posting }
        : null,
    };
  }

  // ---- Privileged exports (re-auth, per-track, never bulk) ------------------

  // Reveal the EVM BIP-39 mnemonic (the EVM seed + Graphene master root). Re-auth'd.
  async exportEvmMnemonic(password) {
    this._requireEvm();
    return await kvExportMnemonic(this._evm, password);
  }

  // Reveal a single Graphene WIF role key. Re-auth'd (delegates to AK2 exportKey).
  async exportGrapheneKey(role, password) {
    this._requireGraphene();
    if (typeof this._graphene.exportKey !== "function") {
      throw new Error("graphene backend does not support exportKey");
    }
    return await this._graphene.exportKey(role, password);
  }

  // ---- Lock: zeroize BOTH tracks -------------------------------------------

  lock() {
    if (this._evm && typeof this._evm.lock === "function") this._evm.lock();
    if (this._graphene && typeof this._graphene.lock === "function") this._graphene.lock();
    this.locked = true;
  }

  // ---- guards --------------------------------------------------------------

  _requireUnlocked() {
    if (this.locked) throw new Error("identity is locked");
  }
  _requireEvm() {
    if (this.locked) throw new Error("identity is locked");
    if (!this._evm) throw new Error("no EVM account linked to this identity");
  }
  _requireGraphene() {
    if (this.locked) throw new Error("identity is locked");
    if (!this._graphene) throw new Error("no Graphene account linked to this identity");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Compose an unlocked EVM vault + a Graphene signer into one identity.
//   { label, evmVault, grapheneSigner, pairing:{evmIndex} }
// Either backend may be omitted (e.g. a Graphene-only login can't produce an EVM signer).
export function createIdentity(opts = {}) {
  if (!opts.evmVault && !opts.grapheneSigner) {
    throw new Error("createIdentity needs at least one of evmVault / grapheneSigner");
  }
  return new MultiChainIdentity(opts);
}

// ---------------------------------------------------------------------------
// Fixture Graphene signer
// ---------------------------------------------------------------------------
//
// Deterministic stand-in for the AK2 graphene-signer, so identity.mjs + its tests run
// standalone before AK2 lands. NOT for production: it mirrors the Graphene getPrivateKeys
// brain-key shape (sha256(account + role + masterPw)) and emits MLK-prefixed pubkeys, but
// uses ethers secp256k1 rather than the full Graphene WIF/op-encoding stack.
//
// The REAL AK2 module is injected in its place unchanged; this satisfies the same surface:
//   { account, pubkeys{4}, signOp(op,role), signBuffer(buf,role),
//     verifyAuthChallenge(challenge,sig), exportKey(role,password), lock() }
export function makeFixtureGrapheneSigner(account, masterPw, prefix = "MLK") {
  if (typeof account !== "string" || account.length === 0) {
    throw new Error("account must be a non-empty string");
  }
  if (typeof masterPw !== "string" || masterPw.length === 0) {
    throw new Error("masterPw must be a non-empty string");
  }

  // Graphene getPrivateKeys shape: per-role brain key = sha256(account + role + masterPw).
  function rolePriv(role) {
    return sha256(new TextEncoder().encode(account + role + masterPw));
  }

  let keys = {};
  const pubkeys = {};
  for (const role of GRAPHENE_ROLES) {
    const w = new Wallet(rolePriv(role));
    keys[role] = w;
    // Graphene-shaped public key string: PREFIX + secp256k1 pubkey hex (fixture form).
    pubkeys[role] = prefix + w.signingKey.compressedPublicKey.slice(2);
  }

  let locked = false;

  return {
    account,
    pubkeys,

    // Role-gated op signing (AK3 policy is enforced in the real signer; here we mirror the
    // headline rule so cross-track tests are meaningful: posting may not sign value ops).
    signOp(op, role) {
      if (locked) throw new Error("graphene signer is locked");
      if (!GRAPHENE_ROLES.includes(role)) throw new Error(`unknown role "${role}"`);
      const type = op?.[0] ?? op?.type;
      const valueOps = new Set(["transfer", "account_update", "transfer_to_vesting"]);
      if (role === "posting" && valueOps.has(type)) {
        throw new Error(`posting key may not sign "${type}"`);
      }
      if (role === "active" && type === "account_update") {
        throw new Error("account_update is owner-only");
      }
      const digest = sha256(new TextEncoder().encode(JSON.stringify(op)));
      return keys[role].signingKey.sign(digest).serialized;
    },

    signBuffer(buf, role = "posting") {
      if (locked) throw new Error("graphene signer is locked");
      if (!GRAPHENE_ROLES.includes(role)) throw new Error(`unknown role "${role}"`);
      const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : getBytes(buf);
      const digest = sha256(bytes);
      return keys[role].signingKey.sign(digest).serialized;
    },

    verifyAuthChallenge(challenge, sig) {
      // Fixture verify: re-sign and compare (real AK2 recovers the pubkey).
      return this.signBuffer(challenge, "posting") === sig;
    },

    async exportKey(role, password) {
      if (!GRAPHENE_ROLES.includes(role)) throw new Error(`unknown role "${role}"`);
      if (password !== masterPw) throw new Error("incorrect password");
      // Fixture "WIF": the role private key hex. Real AK2 returns base58 WIF.
      return keys[role].privateKey;
    },

    lock() {
      keys = {};
      locked = true;
    },
  };
}

export { MultiChainIdentity };
