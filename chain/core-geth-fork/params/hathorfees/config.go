// Copyright 2026 The PRANA / Van Kush Family Research Institute Authors.
// SPDX-License-Identifier: LGPL-3.0-or-later

package hathorfees

import "github.com/ethereum/go-ethereum/common"

// GenesisConfig is the JSON shape of the "hathorFee" object in the PRANA genesis /
// chain config. It is decoded by core-geth's config loader and converted to *Config.
//
// Example (chain/genesis/prana.genesis.json, under "config"):
//
//	"hathorFee": {
//	  "feeBps": 500,
//	  "feeAddress": "0x000000000000000000000000000000000048a740",
//	  "activationBlock": 0,
//	  "potAddress": "0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff",
//	  "potActivationBlock": 200000
//	}
//
// feeBps is in basis points (500 = 5.00%). feeAddress is the protocol beneficiary
// (intended: the HathorFeeTreasury contract). activationBlock is the first height the
// fee applies (0 = from genesis).
//
// potAddress / potActivationBlock (OPTIONAL — the "chain IS the pool" hardfork): from
// potActivationBlock onward, the non-Hathor remainder of the winner reward AND every uncle
// reward is credited to potAddress (the hardcoded pool payout wallet) instead of the
// sealer's / uncle's coinbase. Both fields are pointers with omitempty so that a config
// without them decodes AND re-encodes byte-identically to the pre-fork format (the stored
// chain config is compared by its JSON encoding in core.SetupGenesisBlock).
type GenesisConfig struct {
	FeeBps             uint64          `json:"feeBps"`
	FeeAddress         common.Address  `json:"feeAddress"`
	ActivationBlock    uint64          `json:"activationBlock"`
	PotAddress         *common.Address `json:"potAddress,omitempty"`
	PotActivationBlock *uint64         `json:"potActivationBlock,omitempty"`
	// pot2Address / pot2ActivationBlock (OPTIONAL): from pot2ActivationBlock onward the pot
	// recipient switches to pot2Address. Same omitempty rule, so older configs re-encode unchanged.
	Pot2Address         *common.Address `json:"pot2Address,omitempty"`
	Pot2ActivationBlock *uint64         `json:"pot2ActivationBlock,omitempty"`
}

// ToConfig converts the decoded genesis object into the consensus Config. A nil
// receiver (no "hathorFee" key in genesis) yields a nil Config, which Active() treats
// as the module being disabled — so a chain that omits the key behaves exactly like
// stock core-geth and is fully backward compatible.
func (g *GenesisConfig) ToConfig() *Config {
	if g == nil {
		return nil
	}
	c := &Config{
		FeeBps:          g.FeeBps,
		FeeAddress:      g.FeeAddress,
		ActivationBlock: g.ActivationBlock,
	}
	if g.PotAddress != nil {
		c.PotAddress = *g.PotAddress
	}
	if g.PotActivationBlock != nil {
		v := *g.PotActivationBlock
		c.PotActivationBlock = &v
	}
	if g.Pot2Address != nil {
		c.Pot2Address = *g.Pot2Address
	}
	if g.Pot2ActivationBlock != nil {
		v := *g.Pot2ActivationBlock
		c.Pot2ActivationBlock = &v
	}
	return c
}
