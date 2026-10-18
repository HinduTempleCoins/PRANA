package proxy

// PRANA payout hardening: template binding.
//
// eth_getWork only hands the pool a seal hash ("hashNoNonce"). To let ANYONE verify that a published
// share was mined on a real PRANA work template (and not on a header from another Etchash chain, or a
// header the pool made up), the pool also records the full pending header and keeps it only if
// keccak256(rlp(header without mixDigest/nonce)) equals a seal hash it actually handed out.
// An outsider then checks: sealHash(header) == share.hashNoNonce, header.number == share.height and
// header.parentHash == canonical hash of block height-1.

import (
	"encoding/json"
	"log"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rlp"
)

type tmplHeader struct {
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
}

// SealHash mirrors core-geth ethash SealHash for a PoW (pre-Shanghai, London) header.
func (h *tmplHeader) SealHash() common.Hash {
	enc := []interface{}{h.ParentHash, h.UncleHash, h.Coinbase, h.Root, h.TxHash, h.ReceiptHash, h.Bloom,
		(*big.Int)(h.Difficulty), (*big.Int)(h.Number), uint64(h.GasLimit), uint64(h.GasUsed), uint64(h.Time),
		[]byte(h.Extra)}
	if h.BaseFee != nil {
		enc = append(enc, (*big.Int)(h.BaseFee))
	}
	b, _ := rlp.EncodeToBytes(enc)
	return crypto.Keccak256Hash(b)
}

func (s *ProxyServer) recordTemplate(sealHash string, height uint64) {
	for attempt := 0; attempt < 3; attempt++ {
		raw, err := s.rpc().GetPendingHeaderRaw()
		if err != nil || raw == nil {
			return
		}
		var h tmplHeader
		if err := json.Unmarshal(raw, &h); err != nil || h.Number == nil || h.Difficulty == nil {
			log.Printf("template binding: cannot decode pending header: %v", err)
			return
		}
		got := h.SealHash().Hex()
		if strings.EqualFold(got, sealHash) {
			b, _ := json.Marshal(h)
			if err := s.backend.WriteTemplate(strings.ToLower(sealHash), height, string(b)); err != nil {
				log.Printf("template binding: redis: %v", err)
			}
			return
		}
	}
	log.Printf("template binding: pending header did not match work %s at height %d (share stays verifiable by PoW only)", sealHash[:10], height)
}
