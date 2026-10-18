// Package sealhash: an independent re-implementation (separate from the pool's) of the PRANA PoW
// seal hash and the Etchash share check, used by the signer daemons and by anyone auditing a round.
package sealhash

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/etclabscore/go-etchash"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rlp"
)

// Header is the subset of an RPC block/pending-block JSON needed for the seal hash.
type Header struct {
	ParentHash  common.Hash    `json:"parentHash"`
	UncleHash   common.Hash    `json:"sha3Uncles"`
	Coinbase    common.Address `json:"miner"`
	Root        common.Hash    `json:"stateRoot"`
	TxHash      common.Hash    `json:"transactionsRoot"`
	ReceiptHash common.Hash    `json:"receiptsRoot"`
	Bloom       types.Bloom    `json:"logsBloom"`
	Difficulty  *hexutil.Big   `json:"difficulty"`
	Number      *hexutil.Big   `json:"number"`
	GasLimit    hexutil.Uint64 `json:"gasLimit"`
	GasUsed     hexutil.Uint64 `json:"gasUsed"`
	Time        hexutil.Uint64 `json:"timestamp"`
	Extra       hexutil.Bytes  `json:"extraData"`
	BaseFee     *hexutil.Big   `json:"baseFeePerGas,omitempty"`
	MixDigest   *common.Hash   `json:"mixHash,omitempty"`
	Nonce       *hexutil.Bytes `json:"nonce,omitempty"`
}

func (h *Header) SealHash() common.Hash {
	enc := []interface{}{h.ParentHash, h.UncleHash, h.Coinbase, h.Root, h.TxHash, h.ReceiptHash, h.Bloom,
		(*big.Int)(h.Difficulty), (*big.Int)(h.Number), uint64(h.GasLimit), uint64(h.GasUsed), uint64(h.Time),
		[]byte(h.Extra)}
	if h.BaseFee != nil {
		enc = append(enc, (*big.Int)(h.BaseFee))
	}
	b, _ := rlp.EncodeToBytes(enc)
	return crypto.Keccak256Hash(b)
}

// Share is the public share record published per round.
type Share struct {
	Login       string `json:"login"`
	Worker      string `json:"worker"`
	Height      uint64 `json:"height"`
	Nonce       string `json:"nonce"`
	HashNoNonce string `json:"hashNoNonce"`
	MixDigest   string `json:"mixDigest"`
	Diff        int64  `json:"diff"`
	TsMs        int64  `json:"tsMs"`
	Block       bool   `json:"block,omitempty"`
}

type Result struct {
	Index  int    `json:"i"`
	OK     bool   `json:"ok"`
	Bound  bool   `json:"bound"` // template header present and consistent
	Reason string `json:"reason,omitempty"`
	Parent string `json:"parentHash,omitempty"` // for the caller's canonical-chain check
}

var maxUint256 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))

type Verifier struct {
	e *etchash.Etchash
}

func NewVerifier(ecip1099FBlock uint64) *Verifier {
	f := ecip1099FBlock
	return &Verifier{e: etchash.New(&f, nil)}
}

// Compute returns (mixDigest, result) of hashimotoLight for a seal hash + nonce at a height.
func (v *Verifier) Compute(height uint64, seal common.Hash, nonce uint64) (common.Hash, common.Hash) {
	return v.e.Light.Compute(height, seal, nonce) // Light guards its cache map internally; compute is read-only
}

func parseNonce(s string) (uint64, error) {
	s = strings.TrimPrefix(strings.ToLower(s), "0x")
	if len(s) != 16 {
		return 0, fmt.Errorf("nonce must be 8 bytes")
	}
	var n uint64
	_, err := fmt.Sscanf(s, "%016x", &n)
	return n, err
}

// VerifyShare checks the Etchash PoW of one share at its declared difficulty and, if a template header
// is supplied, the binding of the share's seal hash to that header.
func (v *Verifier) VerifyShare(i int, s Share, tmpl json.RawMessage, minDiff int64) Result {
	r := Result{Index: i}
	if s.Diff < minDiff || s.Diff <= 0 {
		r.Reason = fmt.Sprintf("diff %d below pool minimum %d", s.Diff, minDiff)
		return r
	}
	nonce, err := parseNonce(s.Nonce)
	if err != nil {
		r.Reason = "bad nonce"
		return r
	}
	seal := common.HexToHash(s.HashNoNonce)
	mix, res := v.Compute(s.Height, seal, nonce)
	if !strings.EqualFold(mix.Hex(), s.MixDigest) {
		r.Reason = "mixDigest mismatch (forged or wrong height/epoch)"
		return r
	}
	target := new(big.Int).Div(maxUint256, big.NewInt(s.Diff))
	if res.Big().Cmp(target) > 0 {
		r.Reason = "PoW result above share target"
		return r
	}
	r.OK = true
	if len(tmpl) > 0 && string(tmpl) != "null" {
		var h Header
		if err := json.Unmarshal(tmpl, &h); err != nil || h.Number == nil {
			r.Reason = "template undecodable"
			return r
		}
		if h.SealHash() != seal {
			r.OK = false
			r.Reason = "template seal hash != share hashNoNonce"
			return r
		}
		if (*big.Int)(h.Number).Uint64() != s.Height {
			r.OK = false
			r.Reason = "template height != share height"
			return r
		}
		r.Bound = true
		r.Parent = h.ParentHash.Hex()
	}
	return r
}

// VerifyBlock checks a sealed chain block header end to end (self-test against real chain blocks).
func (v *Verifier) VerifyBlock(h Header) error {
	if h.MixDigest == nil || h.Nonce == nil || len(*h.Nonce) != 8 {
		return fmt.Errorf("block has no seal")
	}
	n := new(big.Int).SetBytes(*h.Nonce).Uint64()
	mix, res := v.Compute((*big.Int)(h.Number).Uint64(), h.SealHash(), n)
	if mix != *h.MixDigest {
		return fmt.Errorf("mix mismatch: computed %s header %s", mix.Hex(), h.MixDigest.Hex())
	}
	target := new(big.Int).Div(maxUint256, (*big.Int)(h.Difficulty))
	if res.Big().Cmp(target) > 0 {
		return fmt.Errorf("result above block target")
	}
	return nil
}
