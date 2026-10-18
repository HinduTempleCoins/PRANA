"""Minimal JSON-RPC + PotDistributor bindings (eth_abi / eth_account only; no web3).
Private keys are only ever loaded into memory by load_key(); they are never logged or printed."""
import json, os, time, urllib.request

from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

DOMAIN_TYPEHASH = keccak(text="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
ROOT_TYPEHASH = keccak(text="PotRoot(uint64 round,bytes32 root,uint256 total,bytes32 inputsHash,uint64 endBlock,uint64 signerEpoch)")
NAME, VERSION = "PRANA PotDistributor", "1"


class RPC:
    def __init__(self, url, timeout=30):
        self.url, self.timeout = url, timeout

    def __call__(self, method, params=None):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
        r = urllib.request.urlopen(urllib.request.Request(self.url, body, {"Content-Type": "application/json"}),
                                   timeout=self.timeout)
        j = json.loads(r.read())
        if j.get("error"):
            raise RuntimeError(f"{method}: {j['error']}")
        return j["result"]


def sel(sig):
    return keccak(text=sig)[:4]


def load_key(cfg):
    """Signer/relayer key: {"keyFile": hex file} (devnet) or {"keystore": path, "passwordFile": path}."""
    if cfg.get("keystore"):
        with open(cfg["keystore"]) as f, open(cfg["passwordFile"]) as p:
            return Account.from_key(Account.decrypt(json.load(f), p.read().strip()))
    with open(cfg["keyFile"]) as f:
        return Account.from_key(f.read().strip())


class Pot:
    def __init__(self, rpc, address):
        self.rpc, self.addr = rpc, to_checksum_address(address)

    def call(self, sig, args_types, args, out_types, block="latest"):
        data = sel(sig) + (encode(args_types, args) if args_types else b"")
        res = self.rpc("eth_call", [{"to": self.addr, "data": "0x" + data.hex()}, block])
        return decode(out_types, bytes.fromhex(res[2:]))

    def current_round(self, block="latest"):
        return self.call("currentRound()", [], [], ["uint64"], block)[0]

    def active(self, block="latest"):
        r = self.call("active()", [], [], ["bytes32", "uint256", "bytes32", "uint64", "uint64"], block)
        return {"root": "0x" + r[0].hex(), "total": r[1], "inputsHash": "0x" + r[2].hex(), "endBlock": r[3], "postedAt": r[4]}

    def pending(self, block="latest"):
        r = self.call("pending()", [], [], ["bytes32", "uint256", "bytes32", "uint64", "uint64"], block)
        rnd = self.call("pendingRound()", [], [], ["uint64"], block)[0]
        return {"root": "0x" + r[0].hex(), "total": r[1], "inputsHash": "0x" + r[2].hex(), "endBlock": r[3],
                "postedAt": r[4], "round": rnd}

    def total_claimed(self, block="latest"):
        # before the contract exists at that block there is no code: nothing was ever claimed
        if self.rpc("eth_getCode", [self.addr, block]) in ("0x", "0x0", None):
            return 0
        return self.call("totalClaimed()", [], [], ["uint256"], block)[0]

    def received_total(self, block):
        bal = int(self.rpc("eth_getBalance", [self.addr, block]), 16)
        return bal + self.total_claimed(block)

    def threshold(self):
        return self.call("threshold()", [], [], ["uint256"])[0]

    def signer_epoch(self):
        return self.call("signerEpoch()", [], [], ["uint64"])[0]

    def is_signer(self, a):
        return self.call("isSigner(address)", ["address"], [to_checksum_address(a)], ["bool"])[0]

    def challenge_period(self):
        return self.call("challengePeriod()", [], [], ["uint64"])[0]

    def paused(self):
        return self.call("paused()", [], [], ["bool"])[0]

    def claimed(self, a):
        return self.call("claimed(address)", ["address"], [to_checksum_address(a)], ["uint256"])[0]

    def root_digest_onchain(self, rnd, root, total, ih, eb):
        return "0x" + self.call("rootDigest(uint64,bytes32,uint256,bytes32,uint64)",
                                ["uint64", "bytes32", "uint256", "bytes32", "uint64"],
                                [rnd, bytes.fromhex(root[2:]), int(total), bytes.fromhex(ih[2:]), eb], ["bytes32"])[0].hex()

    def logs(self, topic_sig, from_block=0):
        return self.rpc("eth_getLogs", [{"address": self.addr, "fromBlock": hex(from_block), "toBlock": "latest",
                                         "topics": ["0x" + keccak(text=topic_sig).hex()]}])

    def vetoed_roots(self, rnd):
        out = set()
        for lg in self.logs("RootVetoed(uint64,bytes32,address)"):
            if int(lg["topics"][1], 16) == rnd:
                out.add("0x" + lg["data"][2:66])
        return out

    def finalized_roots(self):
        out = {}
        for lg in self.logs("RootFinalized(uint64,bytes32,uint256)"):
            out[int(lg["topics"][1], 16)] = "0x" + lg["data"][2:66]
        return out


def local_digest(chain_id, pot, rnd, root, total, inputs_hash, end_block, signer_epoch):
    ds = keccak(encode(["bytes32", "bytes32", "bytes32", "uint256", "address"],
                       [DOMAIN_TYPEHASH, keccak(text=NAME), keccak(text=VERSION), chain_id, to_checksum_address(pot)]))
    sh = keccak(encode(["bytes32", "uint64", "bytes32", "uint256", "bytes32", "uint64", "uint64"],
                       [ROOT_TYPEHASH, rnd, bytes.fromhex(root[2:]), int(total), bytes.fromhex(inputs_hash[2:]),
                        end_block, signer_epoch]))
    return "0x" + keccak(b"\x19\x01" + ds + sh).hex()


def sign_digest(acct, digest_hex):
    s = acct.unsafe_sign_hash(bytes.fromhex(digest_hex[2:]))
    return "0x" + (s.r.to_bytes(32, "big") + s.s.to_bytes(32, "big") + bytes([s.v])).hex()


def recover(digest_hex, sig_hex):
    return Account._recover_hash(bytes.fromhex(digest_hex[2:]), signature=bytes.fromhex(sig_hex[2:])).lower()


def send_tx(rpc, acct, to, data=b"", value=0, chain_id=None, gas=None, wait=True):
    chain_id = chain_id or int(rpc("eth_chainId"), 16)
    nonce = int(rpc("eth_getTransactionCount", [acct.address, "pending"]), 16)
    gp = int(rpc("eth_gasPrice"), 16)
    tx = {"from": acct.address, "to": to_checksum_address(to) if to else None, "data": "0x" + data.hex(), "value": hex(value)}
    if gas is None:
        gas = int(int(rpc("eth_estimateGas", [{k: v for k, v in tx.items() if v is not None}]), 16) * 13 // 10) + 20000
    signed = acct.sign_transaction({"nonce": nonce, "gasPrice": gp, "gas": gas, "to": tx["to"] or b"",
                                    "value": value, "data": data, "chainId": chain_id})
    h = rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
    if not wait:
        return h
    for _ in range(600):
        rc = rpc("eth_getTransactionReceipt", [h])
        if rc:
            return rc
        time.sleep(1)
    raise RuntimeError(f"tx {h} not mined")


def encode_call(sig, types, args):
    return sel(sig) + encode(types, args)
