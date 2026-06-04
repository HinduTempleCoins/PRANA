// Settlement rails — crypto build ONLY.
//
// At game-over the game asks an off-chain ATTESTER to mint a reward voucher for the run.
// The attester verifies the run, decides the reward `amount`, and signs an EIP-712 voucher
// that the player can later redeem at the ArcadeFaucet contract. THE GAME NEVER HOLDS KEYS
// and never signs anything — it only POSTs the run result and receives a signed voucher.
//
// EXACT on-chain shapes this mirrors (see contracts/contracts/ArcadeFaucet.sol):
//   EIP-712 domain : name="ArcadeFaucet", version="1", verifyingContract=<faucet addr>, chainId=<prana>
//   Voucher struct : Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)
//   Faucet.claim(player, amount, scoreRef, deadline, nonce, signature)
//
// The `scoreRef` is the opaque bytes32 reference the faucet logs; we bind the run to it as
// keccak256(gameId, player, score, runHash) — but the GAME does not compute keccak (no crypto
// lib in the bundle): it sends the RAW fields and the attester computes scoreRef + signs.
//
// Whole module is behind `if (CRYPTO_BUILD)`; with the build-time literal false, Vite
// dead-code-eliminates ALL of this from the clean bundle (no voucher/jsonrpc/wallet strings).

import { CRYPTO_BUILD, GAME_ID, SETTLEMENT } from '../config.js';

// The EIP-712 type string the ArcadeFaucet uses, kept here so off-chain signers/tests can
// assert the exact shape. (Field order MUST match VOUCHER_TYPEHASH in the contract.)
export const VOUCHER_TYPE = 'Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)';

export const VOUCHER_FIELDS = ['player', 'amount', 'scoreRef', 'deadline', 'nonce'];

// Build the request payload POSTed to the attester at game-over. This is what the GAME
// produces; the SERVER turns it into a signed Voucher.
//   run = { player, score, runHash }
export function buildAttestRequest(run) {
  return {
    gameId: GAME_ID, // "wallbreaker"
    player: run.player, // 0x… recipient (also bound into the voucher `player`)
    score: run.score, // final run score (the attester maps score -> reward amount)
    runHash: run.runHash, // integrity digest of the run (anti-tamper; server re-checks)
  };
}

// Shape a fully-signed voucher into the exact argument tuple ArcadeFaucet.claim expects.
// A redeemer (the wallet workspace) calls the faucet with EXACTLY these positional args.
export function toClaimArgs(voucher) {
  return [
    voucher.player,
    voucher.amount, // uint256 (decimal string)
    voucher.scoreRef, // bytes32 (0x… 32-byte hex)
    voucher.deadline, // uint256 unix seconds
    voucher.nonce, // uint256 single-use id
    voucher.signature, // attester ECDSA signature over the EIP-712 digest
  ];
}

// Fixture response — the documented stub the attester would return. Used when no
// SETTLEMENT.attesterUrl is configured, so the game-over flow is demoable end-to-end
// offline. The signature is a placeholder (NOT a valid signature); a real attester
// returns a signature recoverable to an ATTESTER_ROLE address.
export function fixtureVoucher(req) {
  return {
    player: req.player ?? '0x0000000000000000000000000000000000000000',
    amount: '1000000000000000000', // 1.0 PRANA (18 decimals) — demo reward
    // scoreRef the attester WOULD compute as keccak256(abi.encode(gameId, player, score, runHash)).
    scoreRef: '0x' + '00'.repeat(32),
    deadline: Math.floor(Date.now() / 1000) + 3600, // valid 1h
    nonce: '0', // server assigns a unique single-use nonce in production
    signature: '0x' + '00'.repeat(65), // PLACEHOLDER — not a real attester signature
    fixture: true, // flag so callers/UI can show "demo voucher (not redeemable)"
  };
}

// Request a signed voucher for a finished run. Crypto build only; NEVER throws — returns
// null on the clean build or any failure, so game-over UX is never blocked by settlement.
//   run = { player, score, runHash }
export async function requestScoreVoucher(run) {
  // Clean build: compiled out entirely (CRYPTO_BUILD is a build-time literal).
  if (!CRYPTO_BUILD) return null;

  const req = buildAttestRequest(run);
  const url = SETTLEMENT.attesterUrl;

  // No endpoint configured -> return the documented fixture voucher (offline demo path).
  if (!url) return fixtureVoucher(req);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`attester HTTP ${res.status}`);
    const voucher = await res.json();
    // Minimal shape check; a malformed response falls through to null below.
    for (const f of VOUCHER_FIELDS) {
      if (!(f in voucher)) throw new Error(`voucher missing field ${f}`);
    }
    if (!voucher.signature) throw new Error('voucher missing signature');
    return voucher;
  } catch (err) {
    console.warn('[scoreVoucher] settlement skipped:', err.message);
    return null;
  }
}
