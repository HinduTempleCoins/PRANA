# PRANA Temple Volley

**Temple Volley** is a PRANA arcade **Pong**. Two luminous temple-pillar paddles volley a
glowing light-ball across the court; the rally accelerates with every hit, the contact point
on the paddle bends the bounce (english), and it's a straight race to **11**. Plain JavaScript
ES modules, Phaser for rendering, Vite for dev/build, and **every texture drawn procedurally
to canvas** (no binary assets). Finished vs-AI runs can settle to an on-chain reward voucher —
without the game ever holding a key — via a build flag that is dead-code-eliminated from the
public build.

This mirrors the scaffold in `games/naga/` (same dual-build mechanism, same fixture→chain
seam, same pure-logic + `node --test` pattern).

## Quick start

```bash
cd games/temple-volley
npm install        # phaser + vite only (confined to this directory)
npm run dev        # http://localhost:5173 — play it
npm test           # pure-logic unit tests (node --test)
```

## Modes

- **1P vs AI** — you are the **left** paddle (W / S); a capped, deadzone-driven AI plays the
  right. Beatable on purpose (see *AI tuning* below). **This mode is attestable** — a human
  win settles to a score voucher in the crypto build.
- **2P Local** — two humans share the keyboard: **left = W / S**, **right = ↑ / ↓**. **This
  mode never settles** — there is no single attributable winner address, so no voucher is ever
  produced (documented and enforced in code; see *Settlement*).

## Controls

- **Left paddle:** `W` (up) / `S` (down).
- **Right paddle (2P only):** `↑` / `↓`.
- Hold to move; release to stop. Hit the ball **off-center** to bend its trajectory.
- On the match-over screen, **click** to return to the menu.

## The game

- An 800×480 court. Each paddle defends its wall; the ball serves from center.
- **Rally ramp:** every paddle hit multiplies ball speed by `RULES.speedGain` (1.045×),
  clamped to `RULES.maxSpeed` so it stays trackable.
- **English:** the vertical offset of the contact point relative to the paddle center tilts
  the outgoing angle (`RULES.english`), clamped to `RULES.maxBounceAngle` so the ball never
  goes perpetually near-vertical.
- **Serve alternation:** the side that was **scored on** serves the next ball (loser serves) —
  fair restarts that favor the trailing player.
- **First to 11** (`RULES.winScore`), straight (no deuce): first side to reach 11 *with a lead*
  wins.
- **Juice:** screen shake on each paddle hit and a bigger shake on match point; soft goal-side
  glow; dash net.

### AI tuning (why it's beatable)

The whole point of the AI is to be *winnable*. Three knobs in `AI` (`src/config.js`) keep it
fair, and the pure `aiTrackStep` enforces them:

| knob | value | effect |
|------|-------|--------|
| `trackSpeed` | **360 px/s** | The AI paddle's max speed. It is **below** the human paddle speed (460) and far below the ball's late-rally `maxSpeed` (980). A sharp enough angle simply **outruns** the paddle — the primary way to score. |
| `reactionGap` | **22 px** | A vertical **deadzone**: if the predicted ball-Y is within this band of the paddle center, the AI **does not move**. This is human-like hesitation and lets near-center shots sneak past. |
| `errorBias` | **16 px** | The AI aims for the band *edge*, not dead-center, so it **under-corrects** slightly and can be beaten by placement rather than just speed. |

The AI also only reacts when the ball is **incoming**; when the ball is moving away it drifts
back toward center at **half** `trackSpeed`, so it is never perfectly pre-positioned. All of
this is covered by tests asserting the deadzone hold, the speed cap, the slow recentering, and
the field-bounds clamp. Tune by editing `AI` in `src/config.js`.

## Settlement rails (crypto build only)

`src/data/scoreVoucher.js` builds the **exact** payload the on-chain reward path expects. The
game **never holds keys and never signs** — at match-over it POSTs the run to a configurable
**attester** endpoint; the server signs an EIP-712 voucher the player later redeems at
`ArcadeFaucet`.

**Mode gate (important):** `requestScoreVoucher` returns `null` unless `mode === 'vs-ai'`, and
`PlayScene` only calls it when the **human (left)** wins a vs-AI match. **Local 2-player never
settles** — two humans on one keyboard yield no single attributable winner wallet, so a
single-player score voucher would be meaningless. The mode is also carried in the attest
request so the server can reject anything that isn't `vs-ai`.

Exact shapes mirrored from `contracts/contracts/ArcadeFaucet.sol`:

- **EIP-712 domain:** `name="ArcadeFaucet"`, `version="1"`.
- **Voucher struct:** `Voucher(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce)`.
- **Redeem call:** `claim(player, amount, scoreRef, deadline, nonce, signature)` — see
  `toClaimArgs(voucher)` for the exact positional tuple.

`scoreRef` is computed **server-side** as `keccak256(gameId, player, score, runHash)` (the game
ships no hashing/crypto library). When `SETTLEMENT.attesterUrl` is null the module returns a
**documented fixture voucher** (flagged `fixture:true`, placeholder signature — not redeemable)
so the match-over flow is demoable offline.

## Dual build (clean vs crypto)

One build-time flag, `CRYPTO_BUILD` (`vite.config.js` injects `__CRYPTO_BUILD__`; read in
`src/config.js`).

| build  | command                | output         | CRYPTO_BUILD | settlement path                  | crypto UI strings |
|--------|------------------------|----------------|--------------|----------------------------------|-------------------|
| clean  | `npm run build:clean`  | `dist-clean/`  | `false`      | **dead-code-eliminated**         | none              |
| crypto | `npm run build:crypto` | `dist-crypto/` | `true`       | active (attester POST + voucher) | allowed           |

Plain `npm run build` defaults to **clean** (the safest public funnel).

**Verified:** the clean bundle contains **zero** `wallet` / `jsonrpc` / `voucher` / `attester`
/ `nft` strings — `requestScoreVoucher()` returns early on the build-time-false literal and
Vite drops the whole branch.

## Layout

```
index.html              # mount + module entry
src/
  config.js             # field/RULES/AI tuning + CRYPTO_BUILD flag + SETTLEMENT config
  main.js               # Phaser game config, scene list
  scenes/
    BootScene.js        # bakes procedural paddle/ball/net textures, then -> Menu
    MenuScene.js        # title + mode select (vs-AI / 2P local)
    PlayScene.js        # game loop, input, AI wiring, scoring, match-over + settlement
  data/
    scoreVoucher.js     # EIP-712 voucher payload + attester POST (crypto build, vs-ai only)
  logic/
    volley.js           # PURE physics: serve, bounce, english, ramp, AI tracking, scoring
test/
  logic.test.mjs        # node --test (28 cases)
```

## Tests

`src/logic/volley.js` is pure (no Phaser) so it runs under `node --test`: serve geometry,
wall reflection, paddle collision, english direction, the rally speed-ramp + `maxSpeed` clamp,
the bounce-angle clamp, goal detection, scoring/serve-alternation/match-win, and the AI —
specifically the deadzone hold, the `trackSpeed` cap (asserted **below** the human paddle and
ball speeds, the "beatable" invariant), slow recentering, and the field-bounds clamp. Run
`npm test`.

## Notes / constraints

- One self-contained `npm install` (`phaser`, `vite`) confined to `games/temple-volley/`.
- Phaser **4.x**; placeholder art only — every texture is drawn to canvas in `BootScene`.
- PUBLIC repo: only the **PRANA** brand appears in shipped strings; no other ecosystem names.
```
