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
//	  "activationBlock": 0
//	}
//
// feeBps is in basis points (500 = 5.00%). feeAddress is the protocol beneficiary
// (intended: the HathorFeeTreasury contract). activationBlock is the first height the
// fee applies (0 = from genesis).
type GenesisConfig struct {
	FeeBps          uint64         `json:"feeBps"`
	FeeAddress      common.Address `json:"feeAddress"`
	ActivationBlock uint64         `json:"activationBlock"`
}

// ToConfig converts the decoded genesis object into the consensus Config. A nil
// receiver (no "hathorFee" key in genesis) yields a nil Config, which Active() treats
// as the module being disabled — so a chain that omits the key behaves exactly like
// stock core-geth and is fully backward compatible.
func (g *GenesisConfig) ToConfig() *Config {
	if g == nil {
		return nil
	}
	return &Config{
		FeeBps:          g.FeeBps,
		FeeAddress:      g.FeeAddress,
		ActivationBlock: g.ActivationBlock,
	}
}
