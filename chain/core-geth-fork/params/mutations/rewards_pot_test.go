// Copyright 2026 The PRANA / Van Kush Family Research Institute Authors.
// SPDX-License-Identifier: LGPL-3.0-or-later

package mutations_test

import (
	"encoding/json"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/params/mutations"
	"github.com/ethereum/go-ethereum/params/types/coregeth"
	"github.com/holiman/uint256"
)

// The exact chain config stored on all three PRANA mainnet nodes (admin_nodeInfo,
// 2026-10-17), with the hathorFee object substituted per test.
const mainnetCfgTmpl = `{"chainId":712217,"networkId":712217,"eip2FBlock":0,"eip7FBlock":0,"eip150Block":0,"eip155Block":0,"eip160Block":0,"eip161FBlock":0,"eip170FBlock":0,"eip100FBlock":0,"eip140FBlock":0,"eip198FBlock":0,"eip211FBlock":0,"eip212FBlock":0,"eip213FBlock":0,"eip214FBlock":0,"eip658FBlock":0,"eip145FBlock":0,"eip1014FBlock":0,"eip1052FBlock":0,"eip1283FBlock":0,"petersburgBlock":0,"eip152FBlock":0,"eip1108FBlock":0,"eip1344FBlock":0,"eip1884FBlock":0,"eip2028FBlock":0,"eip2200FBlock":0,"eip2384FBlock":0,"eip3554FBlock":0,"ecip1017FBlock":10000,"ecip1017EraRounds":2427507,"hathorFee":HF,"ecip1099FBlock":40000,"eip2565FBlock":0,"eip2718FBlock":0,"eip2929FBlock":0,"eip3198FBlock":0,"eip2930FBlock":0,"eip1559FBlock":0,"eip3541FBlock":0,"eip3529FBlock":0,"ethash":{},"difficultyBombDelays":{"0x0":"0x9402a0"},"blockReward":{"0x0":"0x1bc16d674ec80000"},"requireBlockHashes":null}`

const (
	legacyHF = `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":40000}`
	potHF    = `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":40000,"potAddress":"0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff","potActivationBlock":200000}`
	F        = 200000
)

var (
	treasury = common.HexToAddress("0xF129608bF3BA681012CF82DFfCfBB92563df987e")
	pot      = common.HexToAddress("0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff")
	sealer   = common.HexToAddress("0x1111111111111111111111111111111111111111")
	uncleCB  = []common.Address{common.HexToAddress("0x2222222222222222222222222222222222222222"), common.HexToAddress("0x3333333333333333333333333333333333333333")}
)

func loadCfg(t *testing.T, hf string) *coregeth.CoreGethChainConfig {
	var c coregeth.CoreGethChainConfig
	if err := json.Unmarshal([]byte(strings.Replace(mainnetCfgTmpl, "HF", hf, 1)), &c); err != nil {
		t.Fatal(err)
	}
	return &c
}

func run(t *testing.T, hf string, n uint64, nUncles int) (*state.StateDB, *uint256.Int, []*uint256.Int) {
	cfg := loadCfg(t, hf)
	st, err := state.New(types.EmptyRootHash, state.NewDatabase(rawdb.NewMemoryDatabase()), nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &types.Header{Number: new(big.Int).SetUint64(n), Coinbase: sealer}
	var uncles []*types.Header
	for i := 0; i < nUncles; i++ {
		uncles = append(uncles, &types.Header{Number: new(big.Int).SetUint64(n - 1), Coinbase: uncleCB[i]})
	}
	mutations.AccumulateRewards(cfg, st, h, uncles)
	mr, ur := mutations.GetRewards(cfg, h, uncles)
	return st, mr, ur
}

func feeOf(gross *uint256.Int) (*uint256.Int, *uint256.Int) {
	fee := new(uint256.Int).Mul(gross, uint256.NewInt(200))
	fee.Div(fee, uint256.NewInt(10000))
	return fee, new(uint256.Int).Sub(gross, fee)
}

func TestAccumulateRewards_PotBeforeF_IdenticalToLegacy(t *testing.T) {
	for _, n := range []uint64{1, 9999, 10000, 39999, 40000, 166710, F - 1} {
		for u := 0; u <= 2; u++ {
			a, mr, ur := run(t, legacyHF, n, u)
			b, _, _ := run(t, potHF, n, u)
			if a.IntermediateRoot(true) != b.IntermediateRoot(true) {
				t.Fatalf("n=%d uncles=%d: state root differs before F", n, u)
			}
			// and it is the legacy rule: sealer net, treasury fee (>=40000), uncles to own coinbase
			fee, net := feeOf(mr)
			if n < 40000 {
				fee, net = uint256.NewInt(0), mr
			}
			if b.GetBalance(sealer).Cmp(net) != 0 || b.GetBalance(treasury).Cmp(fee) != 0 || !b.GetBalance(pot).IsZero() {
				t.Fatalf("n=%d u=%d: sealer=%s treasury=%s pot=%s", n, u, b.GetBalance(sealer), b.GetBalance(treasury), b.GetBalance(pot))
			}
			for i := 0; i < u; i++ {
				if b.GetBalance(uncleCB[i]).Cmp(ur[i]) != 0 {
					t.Fatalf("n=%d uncle %d not paid to own coinbase before F", n, i)
				}
			}
		}
	}
}

func TestAccumulateRewards_PotAtAndAfterF(t *testing.T) {
	for _, n := range []uint64{F, F + 1, F + 2427507} { // incl. a later ECIP-1017 era
		for u := 0; u <= 2; u++ {
			st, mr, ur := run(t, potHF, n, u)
			fee, net := feeOf(mr)
			wantPot := new(uint256.Int).Set(net)
			for i := 0; i < u; i++ {
				wantPot.Add(wantPot, ur[i])
				if !st.GetBalance(uncleCB[i]).IsZero() {
					t.Fatalf("n=%d: uncle coinbase %d paid after F", n, i)
				}
			}
			if !st.GetBalance(sealer).IsZero() {
				t.Fatalf("n=%d u=%d: sealer got %s after F (want 0)", n, u, st.GetBalance(sealer))
			}
			if st.GetBalance(treasury).Cmp(fee) != 0 {
				t.Fatalf("n=%d: treasury %s want %s", n, st.GetBalance(treasury), fee)
			}
			if st.GetBalance(pot).Cmp(wantPot) != 0 {
				t.Fatalf("n=%d u=%d: pot %s want %s", n, u, st.GetBalance(pot), wantPot)
			}
			// total issuance unchanged vs legacy at the same height
			lg, _, _ := run(t, legacyHF, n, u)
			sumL := new(uint256.Int).Add(lg.GetBalance(sealer), lg.GetBalance(treasury))
			for i := 0; i < u; i++ {
				sumL.Add(sumL, lg.GetBalance(uncleCB[i]))
			}
			sumP := new(uint256.Int).Add(st.GetBalance(pot), st.GetBalance(treasury))
			if sumL.Cmp(sumP) != 0 {
				t.Fatalf("n=%d: issuance changed legacy=%s pot=%s", n, sumL, sumP)
			}
			// treasury share is exactly 2% of the winner reward, 98% to pot
			if u == 0 && n == F {
				t.Logf("block F: winner reward %s -> treasury %s (2%%), pot %s (98%%), sealer 0", mr, fee, net)
			}
			// a block applying the OLD rule after F has a different state root -> rejected
			if lg.IntermediateRoot(true) == st.IntermediateRoot(true) {
				t.Fatalf("n=%d: legacy and pot roots equal after F", n)
			}
		}
	}
}
