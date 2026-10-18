# PRANA mainnet genesis (chainId / networkId 712217)

Genesis hash: `0x28a669ab975b82a310e4ee5369d044bc2827a1fe6c869a99adfd4d710d78097e`. Fair launch, empty `alloc` (no premine).

Chain-config upgrades on this geth fork are applied by re-running `geth init` with an updated genesis file at a
coordinated block. The files below are that sequence. **`04` is the config the live nodes report today** (2026-10-18).

| file | adds |
|---|---|
| `01-launch.genesis.json` | the launch file as staged (Etchash, ECIP-1017 era decay from block 10,000, hathorFee 2%). Its `activationBlock`/`ecip1099` values were superseded by `02` |
| `02-hathorfee-ecip1099-F40000.genesis.json` | CoreGeth-format config: hathorFee 2% to `0xf129…987e` from block 40,000; ECIP-1099 (Etchash) from block 40,000 |
| `03-pot-F169532.genesis.json` | pot hardfork: from block 169,532 the winner's net block reward and uncle rewards go to PotDistributor v1 `0x0cf0acbdec814cd140b5e12a6e01ece9f0d7410b` |
| `04-pot2-F169688.genesis.json` | from block 169,688 the pot recipient is PotDistributor v2 `0x0c033FF8f3eEF60981574816672E80dEc5404E3C` (**live**) |

The node source for these fields is `chain/core-geth-fork/params/hathorfees/`.
