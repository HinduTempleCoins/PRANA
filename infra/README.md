# infra/ — PRANA mainnet off-chain services (as running 2026-10-18)

| path | what | live source on the deploy host |
|---|---|---|
| `pot-payout/` | Pool-pot payout: deterministic rounds (`payout/roundlib.py`), coordinator `potd2.py` (no key), independent K-of-M `signer.py`, gas-only `relay.py`, share verifier (`tools/`, Go), AI-lane fleet queue + workers (`lanes/`), genesis/pot helpers (`release/`), systemd units (`deploy/`) | `prana-payout/` |
| `pot-payout/contracts/pot-v1/` | `PotDistributor` deployed at `0x0cf0acbdec814cd140b5e12a6e01ece9f0d7410b` (consensus pot from block 169,532) | `prana-payout/contracts` |
| `pot-payout/contracts/pot-v2/` | `PotDistributor` deployed at `0x0c033FF8f3eEF60981574816672E80dEc5404E3C` (consensus pot from block 169,688) | `prana-pot-v2` |
| `pool/open-etc-pool/` | Stratum pool (`oep-pot`): fork of yuriy0803/open-etc-pool @ `fbdcf704` + PRANA patches (EIP-55 logins incl. `ADDRESS.rig`, deny-list, public per-share log, configurable ECIP-1099, PPLNS tests, `cmd/poolminer-run`). GPL-3.0 as upstream. | `prana-payout/oep` (HEAD `0eb2ac66` + working tree) |

Configs: only `*.example.json` files are published. Real configs, keystores and password files live in
`/etc/prana-pot/` on each box (mode 0600) and are never committed. Foundry `lib/` deps
(forge-std, openzeppelin-contracts) are not vendored; run `forge install` before `forge build/test`.
