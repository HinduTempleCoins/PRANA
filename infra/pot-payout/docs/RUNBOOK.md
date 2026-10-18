# PRANA shares payout — go-live runbook (mainnet, chainId 712217)

Status: **NOT executed.** Nothing in this runbook has been run on mainnet. Every mainnet step needs operator
sign-off. The rule throughout is that PRANA never goes offline: nodes upgrade one at a time and the pool always
has a live upstream.

## 0. Operator decisions this runbook encodes
- Consensus pays ONE hardcoded recipient from fork block F: the **PotDistributor contract**, not
  `0xBD749b16…80ff`.
- `0xBD74…80ff` (≈17.79k PRANA from the node's built-in miner) stays a **Hathor treasury wallet** for
  airdrops and sales. It is never part of share payouts:
  - round math uses only `balance(pot) + pot.totalClaimed()`;
  - `make_genesis_pot.py` refuses 0xBD74 as potAddress;
  - the pool and fleet deny-list includes it (add it to `denyLogins`).
- **Conflict to resolve:** the fork agent's staged `/root/prana-fork/release/genesis-pot-F180000.json` still
  has `potAddress = 0xBD74…`. **Do not ship it.** Rebuild with `release/make_genesis_pot.py <F> <potDistributor>`
  (it reuses the fork agent's verified `ACTIVE.json` + `stored_cfg.json` read-only).

## 0b. FINAL mainnet PotDistributor address (fixed 2026-10-17)
- **`0x0cF0AcbDEc814cD140b5e12A6E01EcE9F0D7410B`** = CREATE(`pot-deployer` `0x460745c0308F2B136DE8EB6FEDf5053b61958f00`, nonce 0).
- The address depends only on the deployer and the nonce, not on the bytecode or the constructor args.
- Checked read-only on the mainnet node (2026-10-17): deployer nonce 0, no code and no balance at the address.
- `pot-deployer` was generated fresh on an operator host as an encrypted scrypt keystore
  (dir 0700, files 0600, key never printed). **Move it to the vault / MELEK-Signer.**
- **Its first and only transaction must be the PotDistributor deployment.** Fund it by *sending to it*;
  receiving does not change its nonce. Any other tx from it burns the address. Then a new address is needed and
  the release genesis must be rebuilt.
- **Pre-deploy balance is safe.**
  - PRANA credited to the address before the code exists stays there and is visible to the contract after deployment.
  - Round accounting pins `receivedTotal(F-1)` as a **pre-fork baseline that is never distributed**. Only issuance
    from block F onward is paid by shares (unit test `test_prefork_balance_never_distributed`).
  - Balance reads at blocks before the contract exists treat `totalClaimed` as 0.
- Use this address in steps 3.2-3.6 below (`make_genesis_pot.py <F> 0x0cF0AcbDEc814cD140b5e12A6E01EcE9F0D7410B`).

## 0c. Lost-and-Found (blocks sealed outside the pool)
- **Classification.** After F, every block's 98% and every uncle reward still land in the pot by consensus. For
  each block in a round, potd2 and every signer derive from their own node:
  - the header coinbase;
  - each uncle header's coinbase;
  - the measured pot inflow of that block (Δ(balance + totalClaimed));
  - the split of that inflow between winner and uncles, using core-geth's era-0 formula
    (winner R + nU·R/32 minus 2%; uncle (u+8−n)·R/8).

  The derivation refuses era > 0 until the formula is re-checked.
- **POOL** = coinbase in `poolCoinbases` (the pool node etherbase(s)). That issuance is distributed by shares.
- **OUTSIDE** = any other coinbase. That issuance is **not** given to share-holders. It is credited to a
  Lost-and-Found balance keyed by that coinbase address. Each entry (address, winner/uncle, block, hash, amount)
  is published in `round_N/round.json` (`lostFoundEntries`, `lostFound`) and in `receiver_N.csv`.
- **Release.** In the first round where that exact address has at least one valid share under its EIP-55 pool
  login, its whole Lost-and-Found balance moves into its cumulative earnings in that round's root. Only that
  address can receive it: the leaf is (address, cumulative), and `claim` pays the leaf account even when a third
  party calls it.
- **Solvency.** `D(shares) = received − preFork − prevTotal − prevHeldAI − prevLostFound − newOutside`.
  Held Lost-and-Found counts against the received total. `preFork + total + heldAI + lostFound ≤ receivedTotal`
  is enforced in the round math, and `total ≤ receivedTotal` in the contract.
- **Spoofing** only gives rewards *to* the address written in the immutable header:
  - setting your coinbase to someone else's address gifts them the reward;
  - setting it to the pool etherbase donates it to share-holders.

  Nobody can redirect another miner's reward.
- **Mainnet `poolCoinbases`** = the etherbase of every node that feeds the pool its `eth_getWork`. Today that
  is `prana-mainnet-node` with `--miner.etherbase 0xBD74…`. Recommendations:
  - Before F, give the pool node(s) a dedicated `pool-coinbase` address that receives gas fees only, and pin it.
    Then pool blocks classify as POOL and 0xBD74 stays purely the Hathor treasury.
  - The node's **built-in CPU miner** also seals with that etherbase. After F its blocks count as POOL issuance
    paid to share-holders, but it has no shares itself. Either stop it after F (`miner.threads 0`, remote sealing
    only), or point a real stratum miner at the pool with the Hathor treasury as login, so Hathor earns by shares
    like everyone else.
- **Expiry: never** (default). Changing that needs a new version (new roundlib params signed off by all signers).
  It is not a contract change.

## 1. Keys and roles (names only; no secrets in any repo or log)
| name | what | where | notes |
|---|---|---|---|
| `pot-deployer` | `0x460745c0308F2B136DE8EB6FEDf5053b61958f00`, exactly ONE tx (nonce 0 = the PotDistributor CREATE → `0x0cF0…410B`) | today an encrypted keystore on an operator host → move to operator vault / MELEK-Signer | needs ~0.1 PRANA for gas, nothing else |
| `pot-signer-1/2/3` | EIP-712 round signers (M=3, K=2) | **three different boxes, three different operators if possible** | encrypted keystore + root-only password file (`signer.py` `key.keystore`/`passwordFile`) |
| `pot-guardian` | multisig: veto, pause, unpause | separate from the signers | cannot move funds |
| `pot-timelock` proposer | governance (signer rotation, guardian, period) | **multisig** (see audit C-1) | today the DAO timelock proposer is the single deployer EOA `0x026d…8d11` |
| `pot-relayer` | pays gas for postRoot/finalize/claimMany | any box | no power; keep a small balance |
| `hathor-treasury` (0xBD74) | Hathor's treasury wallet | **move out of the node** (§7) | not part of payouts |

## 2. Parameters (signers pin these; changing any is a coordinated, public act)
```
chainId 712217 · ecip1099FBlock 40000 (verified against real blocks) · roundBlocks 6646 (~24 h at 13 s)
depth 64 · challengePeriod 43200 s (12 h) · unitDiff = minShareDiff = live pool share difficulty
aiWeight "1.0" (see-saw) · banStrikes 3 · luckMin 0.25 · luckMinExpectedBlocks 20 · requireTemplates false
anchors = [Hathor fleet anchor address(es)] · modelSha256 = [88021b98…787d (hathor0-v1)] · genesisStartBlock = F-1
poolCoinbases = [pool node etherbase(s)] · blockReward 2e18 · feeBps 200 · eraRounds 2427507
denyLogins = [pot, 0xF129608b…987e (2% treasury), 0xBD74…80ff (Hathor treasury)]
```
Signer nodes must hold state at `endBlock` when they sign. Use `--gcmode archive`; the chain is small, so this
is cheap. A snap/full node keeps only 128 recent states, which is too tight.

## 3. Deploy the PotDistributor so potAddress is fixed BEFORE anything ships
1. `pot-deployer` already exists (§0b). Operator moves it into custody. Fund it with ~0.1 PRANA from any wallet; funding does not change its nonce.
2. `release/predict_pot_address.py <deployer> 0 --rpc https://rpc.prana.melek.salon`. This prints the pot address,
   which is `CREATE(deployer, 0)`, and checks live nonce == 0 and no code at the address.
   **Publish this address.** It is now fixed.
3. Decide the constructor args:
   - `timelock`: recommended a NEW TimelockController with a multisig proposer, the guardian as canceller, and
     minDelay ≥ 24 h. Alternatively the DAO timelock `0x574DeEaa…0da4` (48 h, single-EOA proposer: audit C-1).
   - `guardian` multisig.
   - the 3 signer addresses, K=2, challengePeriod 43200.
4. Deploy at nonce 0, signed via MELEK-Signer/keystore, never a plaintext key:
   ```
   forge create --broadcast --rpc-url <rpc> --keystore <pot-deployer.json> \
     src/PotDistributor.sol:PotDistributor --constructor-args <timelock> <guardian> "[s1,s2,s3]" 2 43200
   ```
   Note `foundry.toml`: `evm_version = london`, `bytecode_hash = none`.
5. `release/verify_pot.py <rpc> <potAddress>`. It must print `bytecodeMatch: true`, `domainOk: true` and the
   expected timelock, guardian, signers, threshold and period. Have a second person run it independently.
   If anything is wrong, the address is burned. Repeat with a new deployer **before** step 6. No node has the
   address yet, so nothing is lost.
6. `release/make_genesis_pot.py <F> <potAddress>` → `genesis-pot-F<F>-<addr>.json`. Run the fork agent's
   `precheck.py <node-rpc> <that file>` on each node. It must say PRECHECK OK; the only diff allowed is the two pot fields.

## 4. Choosing F
- At least 24 h after the release is in every operator's hands. **Recommended: 48 h** (~13,300 blocks at 13 s)
  after step 6.
- F = (head at release time) + 13,300, rounded to a round number. Mainnet head ≈ 166,975 on 2026-10-17 08:00 CEST.
- 180000 (the fork agent's draft) is only valid if the release ships before head ≈ 173,300.
- Every node that is not upgraded by F forks off at F. That includes third-party nodes and solo miners. The
  devnet proved patched and unpatched nodes reject each other's blocks at F (`/root/prana-fork/devnet/devnet.out`).

## 5. Rolling node upgrade, zero downtime (3 mainnet nodes)
Order: the two non-mining nodes first, then the mining/pool node. One at a time; never two down together.
For each node:
1. Confirm the other two are synced: `eth_blockNumber` within 2 blocks, peers ≥ 1.
2. If it is the pool upstream, point the pool at another upstream first. oep supports several `upstream`
   entries with health checks; wait until it logs the switch.
3. `systemctl stop <node>`.
4. Back up the binary. Install the release `geth-pot` (verify against the fork agent's SHA256SUMS).
5. `geth --datadir <dir> init genesis-pot-F<F>-<addr>.json`. This rewrites the stored chain config. F is in
   the future, so it is compatible.
6. `systemctl start <node>`. `admin_nodeInfo` must show `hathorFee.potAddress == pot` and `potActivationBlock == F`.
   The node must be importing new blocks within 1 minute.
7. Re-run `precheck.py`. Then move to the next node.

Expected downtime per node is about 10-30 s, during which the other two keep the chain going. The built-in miner
on `prana-mainnet-node` pauses during its own restart only.

## 6. Pool switch-over (at F)
- **Critical: before F, disable the old pool's block unlocker and payer, or cap them at height F-1.**
  - The stock unlocker credits miners per matured block from a *computed* reward. After F those rewards land in
    the pot, not in the pool wallet.
  - If the payer keeps running, it pays miners out of `0xBD74`, which is now Hathor's treasury.
- Replace the pool binary with `bin/oep-pot`, built from `/root/prana-payout/oep`. Config deltas:
  - `ecip1099FBlock: 40000`
  - `requireChecksum: true`: announce ≥ 48 h ahead, because miners using lowercase logins will be refused
  - `denyLogins`: pot, 2% treasury, 0xBD74
  - `templateBinding: false` (see VERIFY doc)
  - policy banning/limits on
  - `unlocker.enabled` and `payouts.enabled` set to false
- Restart it while miners reconnect: stratum miners reconnect automatically, with seconds of lost hashing.
- The share log (`etc:sharelog` ZSET, scored by height) starts filling. potd2 reads `(F-1, F-1+roundBlocks]`.
- **Etherbase:**
  - After F, issuance goes to the pot by consensus whatever etherbase is set. The etherbase receives only gas fees.
  - Before F (operator decision), our own built-in miner may keep `--miner.etherbase 0xBD74`, since it is
    Hathor's treasury. Recommended alternative: switch it now to a fresh `hathor-treasury` address held in proper
    custody (§7), so the node no longer needs any unlocked key.
  - Either way, remove `--unlock … --allow-insecure-unlock` (§7).

## 7. Hathor treasury custody (0xBD74). Documented only; keys untouched.
- Today `prana-mainnet-node.service` runs `--unlock 0xBD74… --password /root/pool/poolpass --allow-insecure-unlock`
  with `--http.api eth,net,web3,miner,admin,txpool` on 127.0.0.1:8557.
  - Any local process can send from that wallet.
  - The password sits in plaintext.
- Plan:
  1. Export the key into the operator vault.
  2. Serve it only through MELEK-Signer-style signing: a scoped token, per-tx approval, airdrop and sale
     templates. This lets Hathor use it without the node holding it.
  3. Remove `--unlock`, `--password` and `--allow-insecure-unlock`, and drop `admin,miner` from `--http.api`.
     This takes a rolling restart (§5).
  4. Delete `/root/pool/poolpass` and the pool's plaintext poolkey once the vault copy is verified.

## 8. Daemons and placement
| daemon | box | notes |
|---|---|---|
| `potd2.py` (coordinator) | pool box (has redis + fleetq) | no key; publishes `/round_N/` over HTTPS (static) |
| `signer.py` #1 | box A with its own archive PRANA node | every share PoW-checked (mandatory); `aiRerun 0.2` (has hathor0) |
| `signer.py` #2 | box B (e.g. chain host) with its own archive node | every share PoW-checked |
| `signer.py` #3 | box C, independent VPS, ideally a different person | every share PoW-checked |
| `relay.py` | anywhere (can be the pool box) | `--loop 60`; push run daily with `--push-max-wei` (e.g. 5 PRANA) |
| `fleetq.py` | pool box | from `/root/prana-payout/lanes`, `--redis-port 0` (pot reads `/export`) |

- The signers must **not** share a box, a node, or an operator with the coordinator.
- Each signer serves only its own `sigDir` over HTTP(S).
- systemd: `ExecStart=/root/prana-payout/venv/bin/python <daemon> <cfg.json> --loop 60`, `Restart=always`,
  `Nice=10`, key files mode 0600.

## 9. Monitoring and alerts
- Pot inflow: every block from F, Δpot ≥ 1.96 PRANA. Alert if a block pays the sealer issuance or Δpot = 0.
- `RootPosted` vs each signer's own computed root. Alert on a signer `ALERT_PENDING_ROOT_MISMATCH` or any
  `REFUSED` log. The guardian vetoes within the 12 h window.
- `RootVetoed`, `Paused`, `SignersUpdated`, `GuardianUpdated`, and timelock `CallScheduled` targeting the pot.
  Any of these pages the operator.
- Liveness: no `RootFinalized` within `roundBlocks + depth + 2·challenge` means signers or the relayer are down.
- Pool: invalid-share ratio per IP, refused logins, duplicate rate, luck per round (signer logs).
- Fleet: strikes and bans; disputed jobs.
- Solvency (should be impossible to break; check anyway): `pot.balance + totalClaimed == Σ consensus credits`
  and `totalClaimed ≤ active.total`.
- Hathor treasury `0xBD74`: balance changes only via approved treasury operations after F.

## 10. Rollback
- Before F: every step is reversible. Re-init with the old genesis config and swap the binary back.
- After F: there is no rollback of consensus without another fork. Funds in the pot are safe even if the
  off-chain pipeline fails: pause, veto, rotate signers via the timelock, recompute.

## Unverified / open
- Mainnet steps (deploy, rolling upgrade, pool switch) have **not** been run.
- Template binding is not functional with core-geth's sanitized pending block.
- The live pool's share difficulty and its exact payer and unlocker setup on mainnet have not been inspected.
- The mainnet guardian multisig and the new timelock do not exist yet.
