/**
 * pack-opening.mjs — AK9 + AK10
 *
 * Headless commit/reveal driver for opening a "pack" (a gacha pull) against the
 * on-chain {GachaMintOnCommit} contract. It mirrors that contract's hardened
 * two-phase flow EXACTLY — see contracts/contracts/GachaMintOnCommit.sol:
 *
 *   Phase 1 — commit(saltHash[, payer]):
 *     The user picks a SECRET 32-byte `salt`, hashes it as
 *       saltHash = keccak256(abi.encodePacked(salt))
 *     and submits the hash (NOT the salt). The contract records block.number as
 *     the commit block and escrows the price. Emits
 *       Committed(address indexed user, uint256 commitBlock, bytes32 saltHash).
 *     One open commit per user at a time (CommitOpen otherwise).
 *
 *   Phase 2 — reveal(salt):
 *     Once block.number > commitBlock + 1 (the reveal target block is
 *     commitBlock+1), the user reveals the pre-image `salt`. The contract checks
 *     keccak256(salt) == saltHash (BadSalt otherwise), seeds randomness from
 *     blockhash(commitBlock+1) MIXED with the committer + salt, draws a rarity by
 *     disclosed weight, mints the ERC-721 and emits
 *       Revealed(address indexed user, uint256 indexed tokenId, uint256 rarityIndex).
 *     Past the 256-block lookback (block.number > commitBlock + EXPIRY_BLOCKS)
 *     the blockhash is gone: reveal reverts TooLate and the escrow must instead
 *     be reclaimed via refundExpired().
 *
 * Why the two phases can't be gamed (from the contract's NatSpec): the salt is
 * hash-committed before the reveal blockhash is known, and the blockhash is
 * fixed before the salt is revealed — so neither a colluding miner nor the user
 * can grind the seed.
 *
 * This driver:
 *   - builds the commit tx and the reveal tx (via lib/txbuilder.mjs — same RPC
 *     path the send-flow uses; we never re-implement tx logic);
 *   - decodes the minted tokenId(s) + rarity from the `Revealed` event(s) in the
 *     reveal receipt, and resolves the rarity NAME from the contract's disclosed
 *     `rarityNames()` table;
 *   - exposes an explicit state machine:
 *
 *       idle ─commit()→ committing ─→ committed ─(reveal block mined)→ revealable
 *                                          │                                │
 *                                          └──────── reveal() ──────────────┘
 *                                                         │
 *                                                  revealing ─→ revealed
 *                                                         └──────→ failed (any step)
 *
 * Coupling matches the rest of lib/: an ethers-style `provider` (send/request)
 * and an injected ethers `Wallet`/`Signer` for broadcasts. A `fixture` lets the
 * whole flow run with NO node (tests + the offline app demo) — the fixture stands
 * in for the chain: it answers the reveal-readiness check and yields the
 * Revealed event the reveal would have produced.
 *
 * ethers v6.
 */

import {
  Interface,
  getAddress,
  isHexString,
  keccak256,
  solidityPackedKeccak256,
  hexlify,
  randomBytes,
} from 'ethers';
import { buildTx, sendAndWait, dryRun, decodeRevert } from './txbuilder.mjs';

// The exact subset of the GachaMintOnCommit ABI this driver binds. Function and
// event names/shapes copied verbatim from the contract — do not invent.
export const GACHA_ON_COMMIT_ABI = [
  // commit: two overloads (caller-pays + relayer-pays)
  'function commit(bytes32 saltHash)',
  'function commit(bytes32 saltHash, address payer)',
  // reveal: returns the minted tokenId
  'function reveal(bytes32 salt) returns (uint256 tokenId)',
  // reclaim an expired commit's escrow
  'function refundExpired() returns (uint256 amount)',
  // pure helper to compute the committed hash on-chain (we mirror it off-chain)
  'function saltHashOf(bytes32 salt) pure returns (bytes32)',
  // commit bookkeeping + disclosed-odds views
  'function commitments(address user) view returns (uint256 commitBlock, uint256 escrow, bytes32 saltHash)',
  'function isExpired(address user) view returns (bool)',
  'function rarityNames() view returns (string[])',
  'function rarityName(uint256 index) view returns (string)',
  'function rarityCount() view returns (uint256)',
  'function EXPIRY_BLOCKS() view returns (uint256)',
  // events
  'event Committed(address indexed user, uint256 commitBlock, bytes32 saltHash)',
  'event Revealed(address indexed user, uint256 indexed tokenId, uint256 rarityIndex)',
  'event Refunded(address indexed user, uint256 amount)',
];

export const IFACE = new Interface(GACHA_ON_COMMIT_ABI);

export const STATES = Object.freeze({
  IDLE: 'idle',
  COMMITTING: 'committing',
  COMMITTED: 'committed', // commit mined, reveal block not yet reached
  REVEALABLE: 'revealable', // reveal block mined; reveal() will succeed
  REVEALING: 'revealing',
  REVEALED: 'revealed',
  EXPIRED: 'expired', // past the 256-block window — must refundExpired()
  FAILED: 'failed',
});

// blockhash(commitBlock+1) leaves the lookback after 256 blocks (mirrors the
// contract constant; refreshed from the chain when available).
const DEFAULT_EXPIRY_BLOCKS = 256n;

async function rpc(provider, method, params = []) {
  if (typeof provider?.send === 'function') return provider.send(method, params);
  if (typeof provider?.request === 'function') return provider.request({ method, params });
  throw new Error('pack-opening: provider must expose send(method,params) or request({method,params})');
}

function toBig(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  return BigInt(v);
}

/**
 * Generate a fresh secret salt (32 random bytes, 0x-hex). Keep it secret until
 * reveal. Callers who want a recoverable salt may pass their own instead.
 */
export function generateSalt() {
  return hexlify(randomBytes(32));
}

/**
 * Compute the commit hash exactly as the contract does:
 *   keccak256(abi.encodePacked(salt))  with salt a bytes32.
 * abi.encodePacked of a single bytes32 is just the 32 bytes, so this equals
 * keccak256(salt); we use solidityPackedKeccak256 to be unambiguous + match the
 * on-chain saltHashOf().
 */
export function computeSaltHash(salt) {
  if (!isHexString(salt, 32)) throw new Error('pack-opening: salt must be a 32-byte 0x-hex string');
  return solidityPackedKeccak256(['bytes32'], [salt]);
}

/**
 * Decode every Revealed event in a receipt's logs for `user`, resolving the
 * rarity NAME from a names table when supplied.
 * @returns {{tokenId: bigint, rarityIndex: number, rarityName: string|null}[]}
 */
export function decodeReveals(logs, { user, rarityNames } = {}) {
  const out = [];
  const want = user ? getAddress(user) : null;
  for (const log of logs ?? []) {
    let parsed;
    try {
      parsed = IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue; // not one of ours
    }
    if (!parsed || parsed.name !== 'Revealed') continue;
    if (want && getAddress(parsed.args.user) !== want) continue;
    const rarityIndex = Number(parsed.args.rarityIndex);
    out.push({
      tokenId: toBig(parsed.args.tokenId),
      rarityIndex,
      rarityName: rarityNames?.[rarityIndex] ?? null,
    });
  }
  return out;
}

/**
 * Create a pack-opening (commit/reveal) controller.
 *
 * @param {object} deps
 * @param {object}  deps.provider           ethers-style provider (send/request)
 * @param {object}  deps.signer             ethers Wallet/Signer (broadcasts commit+reveal)
 * @param {string}  deps.contract           GachaMintOnCommit address
 * @param {string}  deps.account            the committer (signer's address)
 * @param {string}  [deps.salt]             secret 32-byte 0x salt (default: generated)
 * @param {string}  [deps.payer]            optional relayer payer for commit(saltHash,payer)
 * @param {string[]}[deps.rarityNames]      disclosed names; auto-loaded from chain if omitted
 * @param {object}  [deps.opts]             { chainId?, confirmations?, pollMs?, timeoutMs? }
 * @param {object}  [deps.fixture]          no-node mode — see below
 *
 * fixture shape (all optional):
 *   {
 *     currentBlock: bigint|number,           // moving "block.number"; advanceBlocks() bumps it
 *     expiryBlocks: bigint|number,           // default 256
 *     rarityNames: string[],                 // disclosed odds table
 *     // what reveal() would mint; either provide events or a single (tokenId,rarityIndex):
 *     reveal: { tokenId, rarityIndex } | { events: [{tokenId,rarityIndex}, ...] }
 *       | ((salt) => ({tokenId,rarityIndex}) | {events:[...]}),  // function gets the revealed salt
 *   }
 */
export function createPackOpening({
  provider,
  signer,
  contract,
  account,
  salt,
  payer,
  rarityNames,
  opts = {},
  fixture = null,
} = {}) {
  if (!contract) throw new Error('pack-opening: contract address is required');
  if (!account) throw new Error('pack-opening: account is required');
  if (!fixture && !provider) throw new Error('pack-opening: provider (or fixture) is required');

  const addr = getAddress(contract);
  const acct = getAddress(account);
  const theSalt = salt ?? generateSalt();
  if (!isHexString(theSalt, 32)) throw new Error('pack-opening: salt must be a 32-byte 0x-hex string');
  const saltHash = computeSaltHash(theSalt);

  let state = STATES.IDLE;
  let error = null;
  let commitBlock = null; // bigint
  let revealBlock = null; // bigint = commitBlock + 1
  let expiryBlocks = fixture ? toBig(fixture.expiryBlocks ?? DEFAULT_EXPIRY_BLOCKS) : null;
  let names = rarityNames ? [...rarityNames] : fixture?.rarityNames ? [...fixture.rarityNames] : null;
  let commitResult = null; // { hash, receipt }
  let revealResult = null; // { hash, receipt }
  let cards = null; // decoded [{tokenId, rarityIndex, rarityName}]

  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) fn(snapshot());
  };
  const setState = (s) => {
    state = s;
    emit();
  };
  const fail = (err) => {
    error = { message: err?.message ?? String(err), code: err?.code, revertReason: err?.revertReason };
    setState(STATES.FAILED);
    return null;
  };

  function snapshot() {
    return {
      state,
      error,
      contract: addr,
      account: acct,
      saltHash,
      commitBlock,
      revealBlock,
      expiryBlocks,
      rarityNames: names,
      cards,
      commit: commitResult,
      reveal: revealResult,
    };
  }

  // ---- current block height -------------------------------------------------

  async function currentBlock() {
    if (fixture) return toBig(fixture.currentBlock ?? 0);
    return toBig(await rpc(provider, 'eth_blockNumber', []));
  }

  async function ensureExpiry() {
    if (expiryBlocks != null) return expiryBlocks;
    try {
      const tx = await buildTx(
        { from: acct, to: addr, data: IFACE.encodeFunctionData('EXPIRY_BLOCKS', []) },
        provider,
        { chainId: opts.chainId, gasLimit: 100000n },
      );
      const out = await rpc(provider, 'eth_call', [{ to: addr, data: tx.data }, 'latest']);
      const [eb] = IFACE.decodeFunctionResult('EXPIRY_BLOCKS', out);
      expiryBlocks = toBig(eb);
    } catch {
      expiryBlocks = DEFAULT_EXPIRY_BLOCKS;
    }
    return expiryBlocks;
  }

  async function ensureNames() {
    if (names != null) return names;
    try {
      const out = await rpc(
        provider,
        'eth_call',
        [{ to: addr, data: IFACE.encodeFunctionData('rarityNames', []) }, 'latest'],
      );
      const [list] = IFACE.decodeFunctionResult('rarityNames', out);
      names = [...list];
    } catch {
      names = null; // odds table unavailable — reveal still works, names stay null
    }
    return names;
  }

  // ---- phase 1: commit ------------------------------------------------------

  /**
   * Build + broadcast the commit tx (escrows the pull, records commit block +
   * salt hash). Uses the relayer overload commit(saltHash,payer) when `payer`
   * was supplied, else commit(saltHash).
   */
  async function commit() {
    if (state !== STATES.IDLE && state !== STATES.FAILED) {
      throw new Error(`pack-opening: cannot commit from "${state}"`);
    }
    error = null;
    setState(STATES.COMMITTING);
    try {
      await Promise.all([ensureExpiry(), ensureNames()]);

      const data = payer
        ? IFACE.encodeFunctionData('commit(bytes32,address)', [saltHash, getAddress(payer)])
        : IFACE.encodeFunctionData('commit(bytes32)', [saltHash]);

      if (fixture) {
        // No node: the commit "lands" at the fixture's current block.
        commitBlock = await currentBlock();
        revealBlock = commitBlock + 1n;
        commitResult = { hash: fixtureTxHash('commit'), receipt: { status: '0x1', blockNumber: hexlify32(commitBlock) } };
        setState(STATES.COMMITTED);
        return commitResult;
      }

      const tx = await buildTx({ from: acct, to: addr, data }, provider, {
        chainId: opts.chainId,
      });
      // Surface a clear pre-flight revert (e.g. CommitOpen) instead of a raw send error.
      const sim = await dryRun(tx, provider);
      if (!sim.ok) {
        const reason = sim.revertReason ?? decodeRevert(sim.returnData) ?? 'execution reverted';
        const e = new Error(`commit would revert: ${reason}`);
        e.revertReason = reason;
        throw e;
      }
      commitResult = await sendAndWait(signer, tx, provider, {
        confirmations: opts.confirmations,
        pollMs: opts.pollMs,
        timeoutMs: opts.timeoutMs,
      });
      // Pull the actual commit block out of the Committed event (authoritative).
      commitBlock = extractCommitBlock(commitResult.receipt) ?? toBig(commitResult.receipt?.blockNumber);
      revealBlock = commitBlock + 1n;
      setState(STATES.COMMITTED);
      // If chain already advanced past the reveal block, jump straight to revealable.
      await refreshReadiness();
      return commitResult;
    } catch (err) {
      return fail(err);
    }
  }

  function extractCommitBlock(receipt) {
    for (const log of receipt?.logs ?? []) {
      try {
        const p = IFACE.parseLog({ topics: log.topics, data: log.data });
        if (p?.name === 'Committed' && getAddress(p.args.user) === acct) {
          return toBig(p.args.commitBlock);
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  // ---- readiness: is the reveal block mined / has the commit expired? --------

  /**
   * Re-read the chain height and move COMMITTED → REVEALABLE (or → EXPIRED) when
   * appropriate. Safe to poll. Returns the (possibly unchanged) state.
   */
  async function refreshReadiness() {
    if (state !== STATES.COMMITTED && state !== STATES.REVEALABLE) return state;
    if (commitBlock == null) return state;
    const now = await currentBlock();
    const eb = expiryBlocks ?? DEFAULT_EXPIRY_BLOCKS;
    if (now > commitBlock + eb) {
      setState(STATES.EXPIRED);
    } else if (now > revealBlock) {
      if (state !== STATES.REVEALABLE) setState(STATES.REVEALABLE);
    }
    return state;
  }

  /** Blocks remaining until the reveal block is mined (0 = ready), or null. */
  async function blocksUntilRevealable() {
    if (commitBlock == null) return null;
    const now = await currentBlock();
    const remaining = revealBlock - now;
    return remaining > 0n ? remaining : 0n;
  }

  // ---- phase 2: reveal ------------------------------------------------------

  /**
   * Build + broadcast the reveal tx and decode the minted card(s) + rarity from
   * the Revealed event(s). Rejects if the reveal block hasn't been mined yet
   * (mirrors the contract's TooEarly) and surfaces BadSalt / TooLate cleanly.
   */
  async function reveal() {
    // Refresh once so a caller who never polled still gets the right gate.
    await refreshReadiness();
    if (state === STATES.EXPIRED) {
      return fail(Object.assign(new Error('pack-opening: commit expired — call refundExpired()'), { code: 'EXPIRED' }));
    }
    if (state !== STATES.REVEALABLE) {
      const e = new Error(`pack-opening: not revealable yet (state "${state}"); reveal block not mined`);
      e.code = 'TOO_EARLY';
      return fail(e);
    }
    error = null;
    setState(STATES.REVEALING);
    try {
      await ensureNames();

      if (fixture) {
        const evs = fixtureRevealEvents(fixture, theSalt);
        const logs = evs.map((ev) => buildRevealedLog(acct, ev.tokenId, ev.rarityIndex));
        cards = decodeReveals(logs, { user: acct, rarityNames: names });
        revealResult = { hash: fixtureTxHash('reveal'), receipt: { status: '0x1', logs } };
        setState(STATES.REVEALED);
        return revealResult;
      }

      const data = IFACE.encodeFunctionData('reveal', [theSalt]);
      const tx = await buildTx({ from: acct, to: addr, data }, provider, { chainId: opts.chainId });
      // Pre-flight: turn BadSalt / TooEarly / TooLate into clear reasons.
      const sim = await dryRun(tx, provider);
      if (!sim.ok) {
        const reason = sim.revertReason ?? decodeRevert(sim.returnData) ?? 'execution reverted';
        const e = new Error(`reveal would revert: ${reason}`);
        e.revertReason = reason;
        throw e;
      }
      revealResult = await sendAndWait(signer, tx, provider, {
        confirmations: opts.confirmations,
        pollMs: opts.pollMs,
        timeoutMs: opts.timeoutMs,
      });
      if (revealResult.receipt && toBig(revealResult.receipt.status) === 0n) {
        throw Object.assign(new Error(`reveal reverted on-chain (hash ${revealResult.hash})`), { code: 'REVERTED' });
      }
      cards = decodeReveals(revealResult.receipt?.logs, { user: acct, rarityNames: names });
      if (cards.length === 0) {
        throw new Error('pack-opening: reveal mined but no Revealed event found');
      }
      setState(STATES.REVEALED);
      return revealResult;
    } catch (err) {
      return fail(err);
    }
  }

  function reset() {
    error = null;
    commitBlock = null;
    revealBlock = null;
    commitResult = null;
    revealResult = null;
    cards = null;
    setState(STATES.IDLE);
  }

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get salt() {
      return theSalt;
    },
    get saltHash() {
      return saltHash;
    },
    get cards() {
      return cards;
    },
    snapshot,
    currentBlock,
    commit,
    reveal,
    refreshReadiness,
    blocksUntilRevealable,
    reset,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ---- fixture helpers (no-node mode) ----------------------------------------

function fixtureRevealEvents(fixture, salt) {
  let spec = fixture.reveal;
  if (typeof spec === 'function') spec = spec(salt);
  if (!spec) {
    // sensible default: a single common card
    return [{ tokenId: 0n, rarityIndex: 0 }];
  }
  if (Array.isArray(spec.events)) return spec.events;
  return [spec];
}

/** Build a synthetic Revealed log so the SAME decode path runs in fixture mode. */
function buildRevealedLog(user, tokenId, rarityIndex) {
  const ev = IFACE.getEvent('Revealed');
  const encoded = IFACE.encodeEventLog(ev, [getAddress(user), toBig(tokenId), toBig(rarityIndex)]);
  return { topics: encoded.topics, data: encoded.data };
}

function hexlify32(v) {
  return '0x' + toBig(v).toString(16);
}

function fixtureTxHash(tag) {
  return keccak256(new TextEncoder().encode(`akasha:pack:${tag}:${Date.now()}:${Math.random()}`));
}

export default { createPackOpening, STATES, decodeReveals, computeSaltHash, generateSalt, GACHA_ON_COMMIT_ABI, IFACE };
