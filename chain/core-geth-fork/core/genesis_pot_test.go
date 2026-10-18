// Copyright 2026 The PRANA / Van Kush Family Research Institute Authors.
// SPDX-License-Identifier: LGPL-3.0-or-later

package core

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	hathorfees "github.com/ethereum/go-ethereum/params/hathorfees"
	"github.com/ethereum/go-ethereum/params/types/genesisT"
	"github.com/ethereum/go-ethereum/triedb"
)

const potGenesisTmpl = `{"config":{"chainId":4242,"networkId":4242,"eip2FBlock":0,"eip7FBlock":0,"eip150Block":0,"eip155Block":0,"eip160Block":0,"eip161FBlock":0,"eip170FBlock":0,"ethash":{},"hathorFee":HF},"nonce":"0x42","timestamp":"0x0","extraData":"0x","gasLimit":"0x1c9c380","difficulty":"0x20000","mixHash":"0x0000000000000000000000000000000000000000000000000000000000000000","coinbase":"0x0000000000000000000000000000000000000000","alloc":{}}`

func potGenesis(t *testing.T, hf string) *genesisT.Genesis {
	var g genesisT.Genesis
	s := strings.Replace(potGenesisTmpl, "HF", hf, 1)
	if err := json.Unmarshal([]byte(s), &g); err != nil {
		t.Fatal(err)
	}
	return &g
}

func hfOf(t *testing.T, cfg interface{}) *hathorfees.Config {
	hp, ok := cfg.(interface{ GetHathorFee() *hathorfees.Config })
	if !ok {
		t.Fatalf("config %T has no GetHathorFee", cfg)
	}
	return hp.GetHathorFee()
}

func TestSetupGenesis_RejectsZeroPotAddress(t *testing.T) {
	db := rawdb.NewMemoryDatabase()
	g := potGenesis(t, `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":0,"potActivationBlock":20}`)
	_, _, err := SetupGenesisBlock(db, triedb.NewDatabase(db, nil), g)
	if err != hathorfees.ErrNoPotAddress {
		t.Fatalf("got %v want ErrNoPotAddress", err)
	}
	if rawdb.ReadCanonicalHash(db, 0) != (common.Hash{}) {
		t.Fatal("invalid genesis was written")
	}
}

// Re-running init on an existing datadir with the same genesis block but a hathorFee
// that adds potAddress/potActivationBlock rewrites ONLY the stored chain config
// (same genesis hash), which is the no-resync activation path.
func TestSetupGenesis_ReinitAddsPot(t *testing.T) {
	db := rawdb.NewMemoryDatabase()
	legacy := potGenesis(t, `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":0}`)
	_, h1, err := SetupGenesisBlock(db, triedb.NewDatabase(db, nil), legacy)
	if err != nil {
		t.Fatal(err)
	}
	withPot := potGenesis(t, `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":0,"potAddress":"0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff","potActivationBlock":20}`)
	_, h2, err := SetupGenesisBlock(db, triedb.NewDatabase(db, nil), withPot)
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("genesis hash changed %x -> %x (pot must not affect the genesis block)", h1, h2)
	}
	hf := hfOf(t, rawdb.ReadChainConfig(db, h1))
	if hf.PotActivationBlock == nil || *hf.PotActivationBlock != 20 || hf.PotAddress != common.HexToAddress("0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff") {
		t.Fatalf("stored config not updated: %+v", hf)
	}
	// normal start (no genesis) runs with the stored pot config
	cfg, _, err := SetupGenesisBlock(db, triedb.NewDatabase(db, nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	if hfOf(t, cfg).PotActivationBlock == nil {
		t.Fatal("startup config lost pot")
	}
}
