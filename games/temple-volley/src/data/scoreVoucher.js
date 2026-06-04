// Settlement rails — crypto build ONLY.
//
// At match-over the game asks an off-chain ATTESTER to mint a reward voucher for the run.
// The attester verifies the run, decides the reward `amount`, and signs an EIP-712 voucher
// that the player can later redeem at the ArcadeFaucet contract. THE GAME NEVER HOLDS KEYS
// and never signs anything — it only POSTs the run result and receives a signed voucher.
//
// IMPORTANT (Temple Volley): only the **vs-AI** mode is attestable. A vs-AI win is a single
// human against the deterministic AI, so the score references one player wallet. Local
// 2-player has TWO humans on one keyboard and no single attributable winner address, so it
// NEVER settles — the scene gates the call by mode and `buildAttestRequest` carries the mode
// so the attester can reject anything that isn't `vs-ai`.
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

// Build the request payload POSTed to the attester at match-over. This is what the GAME
// produces; the SERVER turns it into a signed Voucher.
//   run = { player, score, runHash, mode }
export function buildAttestRequest(run) {
  return {
    gameId: GAME_ID, // "temple-volley"
    player: run.player, // 0x… recipient (also bound into the voucher `player`)
    score: run.score, // final winning score (the attester maps score -> reward amount)
    runHash: run.runHash, // integrity digest of the run (anti-tamper; server re-checks)
    mode: run.mode, // 'vs-ai' — local 2P is never sent (no single attributable player)
  };
}

// Shape a fully-signed voucher into the exact argument tuple ArcadeFaucet.claim expects.
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

// Fixture response — the documented stub the attester would return when no endpoint is set.
export function fixtureVoucher(req) {
  return {
    player: req.player ?? '0x0000000000000000000000000000000000000000',
    amount: '1000000000000000000', // 1.0 PRANA (18 decimals) — demo reward
    scoreRef: '0x' + '00'.repeat(32),
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: '0',
    signature: '0x' + '00'.repeat(65), // PLACEHOLDER — not a real attester signature
    fixture: true,
  };
}

// Request a signed voucher for a finished run. Crypto build only; NEVER throws — returns
// null on the clean build, on a non-attestable mode, or on any failure, so match-over UX is
// never blocked by settlement.
//   run = { player, score, runHash, mode }
export async function requestScoreVoucher(run) {
  // Clean build: compiled out entirely (CRYPTO_BUILD is a build-time literal).
  if (!CRYPTO_BUILD) return null;

  // Only vs-AI is attestable — local 2-player has no single attributable winner address.
  if (run.mode !== 'vs-ai') return null;

  const req = buildAttestRequest(run);
  const url = SETTLEMENT.attesterUrl;

  if (!url) return fixtureVoucher(req);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`attester HTTP ${res.status}`);
    const voucher = await res.json();
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
