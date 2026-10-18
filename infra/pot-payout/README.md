# infra/pot-payout — PRANA shares payout (PotDistributor + verifiable rounds)

Status (2026-10-18): **live on PRANA mainnet (chain 712217).** The consensus pot redirect activated at block 169,532 (pot v1) and switched to pot v2 at block 169,688; `potd2.py`, `relay.py` and three independent `signer.py` instances run as services. The devnet scripts below are the isolated test harness (localhost only, chainId 7122188). Paths in this file are relative to this folder (`infra/pot-payout/`); `contracts/` is split into `pot-v1/` and `pot-v2/`.

| path | what |
|---|---|
| `contracts/src/PotDistributor.sol` | the immutable pot contract (consensus pays it; K-of-M EIP-712 roots; challenge window; veto/pause; cumulative claims) |
| `contracts/test/` | 28 unit/fuzz tests + 3 invariants (`forge test`); `slither.out` |
| `payout/roundlib.py` | THE deterministic round function (hash shares + AI credits, see-saw, AI vesting/forfeit, Merkle) |
| `payout/{potd2,signer,relay}.py` | coordinator (no key) · signer daemon (independent recompute) · relayer (gas only, push) |
| `payout/verify.py`, `bin/shareverify` | independent Etchash share verifier (Go, `tools/sealhash`), block-share binding, luck |
| `payout/test_payout.py` | 14 offline tests |
| `oep/` → `bin/oep-pot` | pool patch: EIP-55 logins, deny-list, public per-share record `etc:sharelog`, configurable ECIP-1099 |
| `lanes/fleetq.py` | fleet queue + checksum workers + `/export` of every verified job with all replica outputs |
| `devnet/` | `up.sh`, `deploy.py`, `e2e.py`, `evil_signer.py`, `forged_round.py`, `claim.py`, `down.sh`; transcript in `logs/e2e.transcript` |
| `release/` | `predict_pot_address.py`, `make_genesis_pot.py`, `verify_pot.py` |
| `deploy/` | systemd unit drafts + mainnet signer config example |
| `docs/` | `AUDIT.md`, `RUNBOOK.md`, `VERIFY_AND_DEVCOIN.md` |
