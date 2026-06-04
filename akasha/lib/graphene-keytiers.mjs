// akasha/lib/graphene-keytiers.mjs
//
// The Graphene role-tier model for the Akasha wallet (AK3).
//
// A Graphene account (Hive / BLURT / MELEK) does NOT have a BIP-32 HD tree like the EVM
// side. Instead every account has exactly FOUR role keys, each derived from the same
// master password by hashing a role-tagged seed:
//
//     privKey(role) = sha256( account_name + role + master_password )
//
// This module owns the tier vocabulary, the "which tier may sign what" policy, and the
// derive-all-four helper. The actual secp256k1 / WIF / pubkey work lives in
// graphene-signer.mjs (this module imports from it so there is a single signer boundary).
//
// See design/akasha/graphene-signer-spec.md.

// The four roles, in privilege order (highest first). Order matters for UI display and
// for the "owner can do everything" containment check below.
export const ROLES = Object.freeze(["owner", "active", "posting", "memo"]);

// What each tier is for / what it may authorize. Mirrors the standard Graphene authority
// model used by Hive/BLURT. This is documentation the UI can surface AND the data the
// `tierForOperation` helper consults — keep them in sync.
export const TIER_POLICY = Object.freeze({
  owner: {
    rank: 0,
    label: "Owner",
    purpose:
      "Master key. Recovers the account and changes the other three keys. Used rarely; " +
      "should be kept offline. Can authorize anything active/posting can, plus authority changes.",
    operations: ["account_update", "change_recovery_account", "owner_authority_change"],
  },
  active: {
    rank: 1,
    label: "Active",
    purpose:
      "Money key. Transfers, market orders, power-up/down, witness votes, escrow.",
    operations: [
      "transfer",
      "transfer_to_vesting",
      "withdraw_vesting",
      "limit_order_create",
      "limit_order_cancel",
      "account_witness_vote",
      "escrow_transfer",
    ],
  },
  posting: {
    rank: 2,
    label: "Posting",
    purpose:
      "Social key. Posts, comments, votes, reblogs, follows. The day-to-day key, safe to " +
      "keep on a hot device because it cannot move funds.",
    operations: ["comment", "vote", "custom_json", "reblog", "follow", "delete_comment"],
  },
  memo: {
    rank: 3,
    label: "Memo",
    purpose:
      "Encryption key. Encrypts/decrypts private transfer memos. Does not sign transactions.",
    operations: ["encrypt_memo", "decrypt_memo"],
  },
});

// Validate a role string. Throws on anything not in ROLES.
export function requireRole(role) {
  if (typeof role !== "string" || !ROLES.includes(role)) {
    throw new Error(`invalid graphene role "${role}"; use one of ${ROLES.join(", ")}`);
  }
  return role;
}

// Map a chain operation name to the tier that must sign it. Containment: owner can sign
// anything active or posting can; active can sign anything posting can (Graphene authority
// inheritance). We return the *lowest-privilege* tier that suffices, which is what a wallet
// should prompt for. `memo` ops are not transaction-signed (handled separately).
export function tierForOperation(operation) {
  if (typeof operation !== "string" || operation.length === 0) {
    throw new Error("operation must be a non-empty string");
  }
  for (const role of ROLES) {
    if (TIER_POLICY[role].operations.includes(operation)) return role;
  }
  // Unknown op: default to the money key, the safe-but-strict choice for a wallet prompt.
  return "active";
}

// True if `signingRole` is allowed to authorize an operation that nominally needs
// `requiredRole`, honoring Graphene's owner⊇active⊇posting inheritance. (memo is a
// separate encryption authority and does not participate in this ordering.)
export function roleSatisfies(signingRole, requiredRole) {
  requireRole(signingRole);
  requireRole(requiredRole);
  if (requiredRole === "memo" || signingRole === "memo") {
    return signingRole === requiredRole; // memo only satisfies memo
  }
  return TIER_POLICY[signingRole].rank <= TIER_POLICY[requiredRole].rank;
}

// ---------------------------------------------------------------------------
// Derive all four role keys from a single master password.
//
// Imports the per-role derivation from graphene-signer.mjs so there is exactly ONE place
// that touches private key material. Returns an object keyed by role; each entry is a
// GrapheneSigner (private scalar held in-module, only public material exposed).
//
//   const tiers = deriveAllTiers("alice", "P5J...", { prefix: "MELEK" });
//   tiers.posting.getAddress()  ->  "MELEK6JWq...."
// ---------------------------------------------------------------------------
export async function deriveAllTiers(account, password, opts = {}) {
  // Lazy import to avoid a static import cycle (signer also references tier names).
  const { signerFor } = await import("./graphene-signer.mjs");
  const tiers = {};
  for (const role of ROLES) {
    tiers[role] = signerFor(account, role, password, opts);
  }
  return tiers;
}

// Convenience: just the four public-key strings (no signers retained). Useful for building
// the `account_create` authority block without holding any private material.
export async function derivePublicTiers(account, password, opts = {}) {
  const tiers = await deriveAllTiers(account, password, opts);
  const out = {};
  for (const role of ROLES) {
    out[role] = tiers[role].getAddress();
    tiers[role].wipe();
  }
  return out;
}
