// Copyright 2026 The PRANA / Van Kush Family Research Institute Authors.
// SPDX-License-Identifier: LGPL-3.0-or-later

package hathorfees

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"
)

var hathorAddr = common.HexToAddress("0x000000000000000000000000000000000048A740")

func cfg(bps, activation uint64) *Config {
	return &Config{FeeBps: bps, FeeAddress: hathorAddr, ActivationBlock: activation}
}

// 2 PRANA gross issuance in wei.
func gross2() *uint256.Int {
	g, _ := uint256.FromDecimal("2000000000000000000")
	return g
}

func TestSplit_FivePercent(t *testing.T) {
	c := cfg(500, 0) // 5%
	fee, net := c.Split(1, gross2())

	wantFee, _ := uint256.FromDecimal("100000000000000000")  // 0.1 PRANA
	wantNet, _ := uint256.FromDecimal("1900000000000000000") // 1.9 PRANA
	if fee.Cmp(wantFee) != 0 {
		t.Fatalf("fee = %s, want %s", fee, wantFee)
	}
	if net.Cmp(wantNet) != 0 {
		t.Fatalf("net = %s, want %s", net, wantNet)
	}
	// Invariant: fee + net == gross, always.
	sum := new(uint256.Int).Add(fee, net)
	if sum.Cmp(gross2()) != 0 {
		t.Fatalf("fee+net = %s, want gross %s", sum, gross2())
	}
}

func TestSplit_DisabledWhenZeroBps(t *testing.T) {
	c := cfg(0, 0)
	fee, net := c.Split(100, gross2())
	if !fee.IsZero() {
		t.Fatalf("disabled module took a fee: %s", fee)
	}
	if net.Cmp(gross2()) != 0 {
		t.Fatalf("net = %s, want full gross %s", net, gross2())
	}
}

func TestSplit_InactiveBeforeActivation(t *testing.T) {
	c := cfg(500, 1000) // activates at block 1000
	fee, net := c.Split(999, gross2())
	if !fee.IsZero() {
		t.Fatalf("fee taken before activation: %s", fee)
	}
	if net.Cmp(gross2()) != 0 {
		t.Fatalf("net != gross before activation")
	}
	// At activation it bites.
	fee, _ = c.Split(1000, gross2())
	if fee.IsZero() {
		t.Fatalf("no fee at activation block")
	}
}

func TestSplit_NilConfigIsDisabled(t *testing.T) {
	var c *Config // nil — genesis omitted "hathorFee"
	fee, net := c.Split(5, gross2())
	if !fee.IsZero() || net.Cmp(gross2()) != 0 {
		t.Fatalf("nil config should be a no-op; got fee=%s net=%s", fee, net)
	}
}

// --- Block-validity rule: the heart of the enforcement ---

func TestValidate_ExactFeeValid(t *testing.T) {
	c := cfg(500, 0)
	required := c.RequiredFee(1, gross2())
	if err := c.ValidateBlockFee(1, gross2(), required); err != nil {
		t.Fatalf("exact fee rejected: %v", err)
	}
}

func TestValidate_ShortFeeInvalid(t *testing.T) {
	c := cfg(500, 0)
	required := c.RequiredFee(1, gross2())
	// Credit one wei less than required — the canonical "pool tried to dodge" case.
	short := new(uint256.Int).Sub(required, uint256.NewInt(1))
	if err := c.ValidateBlockFee(1, gross2(), short); err != ErrFeeShort {
		t.Fatalf("short fee accepted; want ErrFeeShort, got %v", err)
	}
}

func TestValidate_ZeroCreditedInvalid(t *testing.T) {
	c := cfg(500, 0)
	// A third-party pool that paid Hathor NOTHING out of issuance — must be invalid.
	if err := c.ValidateBlockFee(1, gross2(), uint256.NewInt(0)); err != ErrFeeShort {
		t.Fatalf("zero-fee block accepted; want ErrFeeShort, got %v", err)
	}
}

func TestValidate_OverpaymentAllowed(t *testing.T) {
	c := cfg(500, 0)
	required := c.RequiredFee(1, gross2())
	over := new(uint256.Int).Add(required, uint256.NewInt(12345))
	if err := c.ValidateBlockFee(1, gross2(), over); err != nil {
		t.Fatalf("overpayment rejected: %v", err)
	}
}

func TestValidate_ZeroFeeAddressRejected(t *testing.T) {
	c := &Config{FeeBps: 500, FeeAddress: common.Address{}, ActivationBlock: 0}
	if err := c.ValidateBlockFee(1, gross2(), uint256.NewInt(1)); err != ErrNoFeeAddress {
		t.Fatalf("zero fee address not caught; got %v", err)
	}
}

func TestValidate_InactiveAlwaysValid(t *testing.T) {
	c := cfg(500, 0)
	// Module disabled (bps 0) — any credit, including zero, is fine.
	c.FeeBps = 0
	if err := c.ValidateBlockFee(1, gross2(), uint256.NewInt(0)); err != nil {
		t.Fatalf("disabled module rejected a block: %v", err)
	}
}

func TestGenesisConfig_ToConfig(t *testing.T) {
	g := &GenesisConfig{FeeBps: 500, FeeAddress: hathorAddr, ActivationBlock: 42}
	c := g.ToConfig()
	if c.FeeBps != 500 || c.FeeAddress != hathorAddr || c.ActivationBlock != 42 {
		t.Fatalf("ToConfig mismatch: %+v", c)
	}
	var nilg *GenesisConfig
	if nilg.ToConfig() != nil {
		t.Fatalf("nil genesis should yield nil config (module disabled)")
	}
}
