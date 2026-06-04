# Entrainment Vertical — Spec (BI15)

> Scope: the "Bio" vertical's entrainment **programs** layer and how the on-chain
> `EntrainmentProgramNFT` contract references the off-chain protocol bundle. This is a
> licensing + accounting rail. It is NOT a medical product and makes NO therapeutic
> claims. Read `design/bio/health-guardrails.md` (LOAD-BEARING) before anything here
> ships to users — that document governs disclaimers, contraindications, and claim
> limits and overrides this one on any safety question.

---

## 1. What the vertical is

A marketplace where **creators publish named "dose" programs** — structured sequences of
audio/visual entrainment content (e.g. tones, beats, or paced patterns) bundled with a
written protocol (how long, what setting, what to expect, what not to do). Buyers acquire
a transferable **license NFT** that references the published program and unlocks the
off-chain content.

The chain does three things and nothing more:
1. records that a program was **published** (an immutable on-chain anchor to the content),
2. **prices and settles** the sale (creator gets paid, protocol takes an optional cut),
3. issues a **license** (an ERC-721 edition) the buyer owns and may resell, with EIP-2981
   royalties flowing back to the creator on secondary sales.

The actual entrainment content (audio files, band schedules, the protocol text, the
safety disclaimers) lives **off-chain**. The chain stores only a hash + URI pointer.

---

## 2. Vocabulary: programs, bands, doses

- **Program** — a creator's published, named template (e.g. "Deep Theta Wind-Down").
  One program, many license editions. On-chain it is a `Program` struct, not an NFT.
- **Dose** — the descriptor of a single intended "use": its **duration** (seconds) and its
  **band set**. A program defines one dose shape. The on-chain fields are a packed
  `durationSecs` + `bandSet`; the full, human-readable dose descriptor lives at `doseURI`.
- **Band** — a named frequency/pattern preset the dose uses (the off-chain catalog maps
  band names to concrete content). On-chain, `bandSet` is an opaque packed `uint64`
  descriptor (e.g. a bitfield of which preset bands the dose includes). The contract does
  **not** interpret it — band semantics are entirely off-chain and may evolve without a
  contract change.
- **Edition / License** — the ERC-721 token a buyer mints. It carries `templateOf[tokenId]`
  pointing back to the program. Owning it = holding a license to the referenced content.

### Why band semantics are off-chain
Keeping the meaning of `bandSet` and the content itself off-chain means the program
catalog, the safety language, and the band presets can be revised, expanded, or corrected
(important for the guardrails) without redeploying or migrating NFTs. The on-chain
`programHash` lets a client verify the off-chain bundle it fetched matches what was
published.

---

## 3. On-chain ↔ off-chain binding

| On-chain field (`Program`) | Meaning | Points to |
| --- | --- | --- |
| `creator` | publisher / payee | — |
| `name` | display name | — |
| `programHash` (`bytes32`) | content-integrity anchor | hash of the off-chain bundle (protocol text + band schedule + audio manifest + disclaimers) |
| `durationSecs` (`uint32`) | dose length | — |
| `bandSet` (`uint64`) | packed band descriptor | off-chain band catalog |
| `doseURI` (`string`) | full descriptor | off-chain JSON (see below) |
| `payToken` / `price` | settlement | ERC-20 (or native if `address(0)`) |
| EIP-2981 royalty (per program) | secondary royalty | creator |

### Off-chain bundle (referenced by `doseURI`, integrity-checked by `programHash`)
A JSON document (stored on IPFS or an HTTPS endpoint) containing at minimum:

```json
{
  "name": "Deep Theta Wind-Down",
  "version": 1,
  "durationSecs": 600,
  "bands": [
    { "name": "theta-6hz", "fromSecs": 0,   "toSecs": 600 }
  ],
  "audioManifest": "ipfs://...",
  "protocol": "Sit or lie down in a quiet, dim room. Use headphones ...",
  "disclaimers": { "required": true, "ref": "health-guardrails.md#disclaimer-block" },
  "contraindications": [ "photosensitive-epilepsy", "..." ],
  "notMedicalAdvice": true
}
```

The client SHOULD compute the hash of the canonicalized bundle and compare it to the
on-chain `programHash` before playing anything, and MUST surface the disclaimer block (see
guardrails) before the dose can start.

---

## 4. Lifecycle

1. **Publish** — creator calls `publishProgram(name, programHash, payToken, price,
   durationSecs, bandSet, doseURI, royaltyBps)`. Mints no NFT; records the template;
   emits `ProgramPublished`. Gated by `publishPermissionless` (owner-only when false).
2. **Buy** — buyer calls `mintEdition(programId, to)` (with native `value` if the program
   is native-priced). Payment routes to creator minus the protocol cut; an edition NFT is
   minted to `to`; emits `EditionMinted`. Reverts if the program is nonexistent or
   inactive, or on under/over-payment.
3. **Use** — client resolves `tokenURI(editionId)` → the program's `doseURI` → fetches +
   verifies the bundle → shows disclaimers/contraindications → plays the dose.
4. **Manage** — creator can `setProgramActive` (pause new sales), `setProgramPrice`.
   Owner can toggle `publishPermissionless` and adjust the protocol fee/treasury.
5. **Resell** — the edition is a normal ERC-721; secondary sales on a 2981-aware
   marketplace pay the creator the configured royalty.

---

## 5. NFT model decision (recorded)

**Chosen: template + edition.** Publishing creates a master *template* (not an NFT);
each purchase mints a fresh *edition* NFT that references the template. Rationale:
- cleanly separates "the published program" from "a license a buyer holds and can resell";
- supports unlimited buyers of the same program without the creator parting with a master;
- per-edition EIP-2981 royalty inherited from the program flows to the creator on resales.

Rejected alternative — *master NFT held by creator + separate license tokens*: more moving
parts (two token types) for no added benefit here; the edition model already gives buyers a
transferable license and the creator a durable claim via the template record + royalties.

---

## 6. Money flow

- Primary sale: `price` → `protocolCut = price * protocolFeeBps / 10000` to
  `protocolTreasury`; remainder to `creator`. Native or single ERC-20 per program.
- Secondary sale: marketplace-enforced EIP-2981 royalty → creator.
- No funds are custodied by the contract beyond the atomic split inside `mintEdition`.

---

## 7. Out of scope (here)

- The off-chain content pipeline, audio synthesis, and band catalog format.
- Any player/app UI (must implement the guardrails' disclaimer gate).
- Curation / trust-tiers of creators (see Marketplace trust-tiers, BI19).
```
