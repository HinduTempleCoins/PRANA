"""Devnet setup: TEST keys (devnet only), deterministic contract addresses, genesis with the pot fork
pointing at the PotDistributor's precomputed CREATE address, and all daemon configs."""
import json, os, sys
import rlp
from eth_account import Account
from eth_utils import keccak, to_checksum_address

D = os.path.dirname(os.path.abspath(__file__))
CHAIN_ID = 7122188
F = 30
TREASURY = "0xF129608bF3BA681012CF82DFfCfBB92563df987e"
K = os.path.join(D, "keys"); os.makedirs(K, exist_ok=True)

def key(name):
    p = os.path.join(K, name + ".key")
    if not os.path.exists(p):
        with open(p, "w") as f: f.write(Account.create().key.hex())
        os.chmod(p, 0o600)
    a = Account.from_key(open(p).read().strip())
    return {"name": name, "keyFile": p, "address": a.address}

def create_addr(sender, nonce):
    return to_checksum_address(keccak(rlp.encode([bytes.fromhex(sender[2:]), nonce]))[12:])

ks = {n: key(n) for n in ["deployer", "guardian", "proposer", "relayer", "signer1", "signer2", "signer3",
                         "miner1", "miner2", "anchor", "ext1", "ext2", "cheat", "attacker", "outsider"]}
TIMELOCK = create_addr(ks["deployer"]["address"], 0)
POT = create_addr(ks["deployer"]["address"], 1)

g = json.load(open("/root/prana-fork/replay/genesis-legacy.json"))
c = g["config"]; c["chainId"] = CHAIN_ID; c["networkId"] = CHAIN_ID; c["ecip1099FBlock"] = 0
c["hathorFee"] = {"feeBps": 200, "feeAddress": TREASURY, "activationBlock": 0, "potAddress": POT, "potActivationBlock": F}
g.pop("_STAGED", None); g.pop("_extraData_ascii", None); g.pop("_difficulty_note", None)
g["extraData"] = "0x" + b"prana-payout-devnet".hex()
g["alloc"] = {ks[n]["address"]: {"balance": hex(b * 10**18)} for n, b in
              [("deployer", 1000), ("relayer", 100), ("guardian", 10), ("proposer", 10), ("miner1", 1), ("attacker", 10), ("outsider", 1)]}
json.dump(g, open(os.path.join(D, "genesis.json"), "w"), indent=1)

params = {"chainId": CHAIN_ID, "pot": POT.lower(), "unitDiff": 3000, "aiWeight": "1.0", "minShareDiff": 3000,
          "ecip1099FBlock": 0, "requireTemplates": False, "luckMin": 0.25, "luckMinExpectedBlocks": 20, "denyLogins": [POT.lower(), TREASURY.lower()],
          "banStrikes": 3, "anchors": [ks["anchor"]["address"].lower()],
          "modelSha256": ["88021b98a2bc3138b2d8f7cb48754822d3f29322f5e96291133cc8a512be787d"],
          "genesisStartBlock": F - 1,
          "poolCoinbases": ["0x1111111111111111111111111111111111111111"], "blockReward": "2000000000000000000",
          "feeBps": 200, "eraRounds": 2427507,
          "aiTypes": {"llm.generate": {"minQuorum": 2, "anchor": True},
                      "embed.text": {"minQuorum": 2, "anchor": True, "cosine": 0.9999}}}
RPC = "http://127.0.0.1:8611"; PUB = "http://127.0.0.1:8631"
common = {"rpc": RPC, "params": params, "roundBlocks": 40, "depth": 3}
cfgs = {
  "potd2.json": dict(common, publishDir=f"{D}/pub", stateDir=f"{D}/state/potd2", redisPort=6395, redisPrefix="etc",
                     fleetq="http://127.0.0.1:8621", shareverify="/root/prana-payout/bin/shareverify"),
  "relay.json": dict(common, publishUrl=PUB, key={"keyFile": ks["relayer"]["keyFile"]},
                     signerSigUrls=[f"http://127.0.0.1:{8640+i}" for i in (1, 2, 3)]),
}
for i in (1, 2, 3):
    cfgs[f"signer{i}.json"] = dict(common, name=f"signer{i}" + ("-EVIL" if i == 3 else ""), publishUrl=PUB,
        key={"keyFile": ks[f"signer{i}"]["keyFile"]}, stateDir=f"{D}/state/signer{i}", sigDir=f"{D}/sigs/signer{i}",
        shareverify="/root/prana-payout/bin/shareverify", aiRerun=0.0)
for n, v in cfgs.items():
    json.dump(v, open(os.path.join(D, n), "w"), indent=1)

pool = {"threads": 2, "coin": "etc", "name": "devnet", "network": "classic", "ecip1099FBlock": 0,
  "proxy": {"enabled": True, "listen": "127.0.0.1:8898", "limitHeadersSize": 1024, "limitBodySize": 256,
    "behindReverseProxy": False, "blockRefreshInterval": "200ms", "stateUpdateInterval": "3s", "difficulty": 3000,
    "hashrateExpiration": "3h", "healthCheck": True, "maxFails": 100,
    "requireChecksum": True, "denyLogins": [POT, TREASURY], "templateBinding": False,
    "stratum": {"enabled": True, "listen": "127.0.0.1:8018", "timeout": "120s", "maxConn": 64},
    "policy": {"workers": 2, "resetInterval": "60m", "refreshInterval": "1m",
      "banning": {"enabled": False, "ipset": "", "timeout": 1800, "invalidPercent": 50, "checkThreshold": 40, "malformedLimit": 5},
      "limits": {"enabled": False, "limit": 30, "grace": "5m", "limitJump": 10}}},
  "api": {"enabled": False}, "upstreamCheckInterval": "5s",
  "upstream": [{"name": "devnet", "url": RPC, "timeout": "10s"}],
  "redis": {"endpoint": "127.0.0.1:6395", "poolSize": 10, "database": 0, "password": ""},
  "unlocker": {"enabled": False}, "payouts": {"enabled": False}, "newrelicEnabled": False}
json.dump(pool, open(os.path.join(D, "pool.json"), "w"), indent=1)
json.dump({n: {"address": v["address"]} for n, v in ks.items()} | {"TIMELOCK": TIMELOCK, "POT": POT, "F": F, "CHAIN_ID": CHAIN_ID},
          open(os.path.join(D, "addresses.json"), "w"), indent=1)
print(json.dumps({"TIMELOCK(deployer nonce 0)": TIMELOCK, "POT(deployer nonce 1)": POT, "F": F, "chainId": CHAIN_ID}))
