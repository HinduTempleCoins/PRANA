"""Merkle tree identical to OpenZeppelin MerkleProof (sorted-pair keccak) with OZ-standard double-hashed
leaves: leaf = keccak256(keccak256(abi.encode(address account, uint256 cumulative))).
Leaves are ordered by account address (lowercase hex) so the tree is canonical for a given map."""
from eth_abi import encode
from eth_utils import keccak, to_checksum_address


def leaf(account: str, cumulative: int) -> bytes:
    return keccak(keccak(encode(["address", "uint256"], [to_checksum_address(account), int(cumulative)])))


def _hp(a: bytes, b: bytes) -> bytes:
    return keccak(a + b) if a < b else keccak(b + a)


def _layers(leaves):
    layers = [list(leaves)]
    while len(layers[-1]) > 1:
        cur = layers[-1]
        nxt = [_hp(cur[i], cur[i + 1]) for i in range(0, len(cur) - 1, 2)]
        if len(cur) % 2:
            nxt.append(cur[-1])
        layers.append(nxt)
    return layers


def build(cumulative: dict):
    """cumulative: {address: int}. Returns (root_hex, {address_lower: [proof_hex...]}, ordered_accounts)."""
    accts = sorted(a.lower() for a in cumulative)
    if not accts:
        return "0x" + "00" * 32, {}, []
    lv = [leaf(a, cumulative[a] if a in cumulative else cumulative[to_checksum_address(a)]) for a in accts]
    layers = _layers(lv)
    proofs = {}
    for i, a in enumerate(accts):
        p, idx = [], i
        for layer in layers[:-1]:
            sib = idx ^ 1
            if sib < len(layer):
                p.append("0x" + layer[sib].hex())
            idx //= 2
        proofs[a] = p
    return "0x" + layers[-1][0].hex(), proofs, accts


def verify(root_hex: str, account: str, cumulative: int, proof) -> bool:
    h = leaf(account, cumulative)
    for p in proof:
        h = _hp(h, bytes.fromhex(p[2:]))
    return "0x" + h.hex() == root_hex.lower()
