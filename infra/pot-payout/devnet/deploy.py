"""Deploy TimelockController (deployer nonce 0) and PotDistributor (nonce 1) on the devnet and prove the
pot landed exactly at the address hardcoded in the fork config (genesis hathorFee.potAddress)."""
import json, os, sys, time
sys.path.insert(0, "/root/prana-payout/payout")
from eth_abi import encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address
from chain import RPC

D = os.path.dirname(os.path.abspath(__file__)); A = json.load(open(f"{D}/addresses.json"))
rpc = RPC("http://127.0.0.1:8611"); CID = A["CHAIN_ID"]
dep = Account.from_key(open(f"{D}/keys/deployer.key").read().strip())
art = lambda p: json.load(open(f"/root/prana-payout/contracts/out/{p}"))["bytecode"]["object"]

def create(code_hex, args_types, args):
    data = bytes.fromhex(code_hex[2:]) + encode(args_types, args)
    nonce = int(rpc("eth_getTransactionCount", [dep.address, "pending"]), 16)
    tx = dep.sign_transaction({"nonce": nonce, "gasPrice": int(rpc("eth_gasPrice"), 16), "gas": 5_000_000,
                               "value": 0, "data": data, "chainId": CID})
    h = rpc("eth_sendRawTransaction", ["0x" + tx.raw_transaction.hex().removeprefix("0x")])
    while not (rc := rpc("eth_getTransactionReceipt", [h])): time.sleep(1)
    return nonce, rc

signers = sorted([A[f"signer{i}"]["address"] for i in (1, 2, 3)], key=lambda a: int(a, 16))
n0, rc0 = create(art("TimelockController.sol/TimelockController.json"), ["uint256", "address[]", "address[]", "address"],
                 [60, [A["proposer"]["address"]], ["0x" + "00" * 20], "0x" + "00" * 20])
n1, rc1 = create(art("PotDistributorDevnet.sol/PotDistributorDevnet.json"), ["address", "address", "address[]", "uint256", "uint64"],
                 [rc0["contractAddress"], A["guardian"]["address"], signers, 2, 90])
code = rpc("eth_getCode", [A["POT"], "latest"])
out = {"timelock": {"nonce": n0, "address": rc0["contractAddress"], "block": int(rc0["blockNumber"], 16), "expected": A["TIMELOCK"]},
       "pot": {"nonce": n1, "address": rc1["contractAddress"], "block": int(rc1["blockNumber"], 16), "expected(fork potAddress)": A["POT"],
               "runtimeCodeKeccak": "0x" + keccak(bytes.fromhex(code[2:])).hex(), "gasUsed": int(rc1["gasUsed"], 16)},
       "forkBlockF": A["F"], "signers": signers, "threshold": 2, "challengePeriodSec": 90}
out["match"] = to_checksum_address(rc1["contractAddress"]) == A["POT"] and out["pot"]["block"] < A["F"]
print(json.dumps(out, indent=1))
