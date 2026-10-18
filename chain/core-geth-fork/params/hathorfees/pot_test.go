// Copyright 2026 The PRANA / Van Kush Family Research Institute Authors.
// SPDX-License-Identifier: LGPL-3.0-or-later

package hathorfees

import (
	"encoding/json"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"
)

var (
	potTreasury = common.HexToAddress("0xF129608bF3BA681012CF82DFfCfBB92563df987e")
	potPool     = common.HexToAddress("0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff")
	potSealer   = common.HexToAddress("0x00000000000000000000000000000000000005ea")
)

func u64p(v uint64) *uint64 { return &v }

func potCfg(f uint64) *Config {
	return &Config{FeeBps: 200, FeeAddress: potTreasury, ActivationBlock: 40000, PotAddress: potPool, PotActivationBlock: u64p(f)}
}

func TestPot_AbsentIsLegacy(t *testing.T) {
	c := &Config{FeeBps: 200, FeeAddress: potTreasury, ActivationBlock: 40000}
	for _, n := range []uint64{0, 39999, 40000, 1 << 40} {
		if c.PotActive(n) || c.RewardRecipient(n, potSealer) != potSealer {
			t.Fatalf("pot must be inert when not configured (n=%d)", n)
		}
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("legacy config must validate: %v", err)
	}
	var nilc *Config
	if nilc.PotActive(5) || nilc.RewardRecipient(5, potSealer) != potSealer || nilc.Validate() != nil {
		t.Fatal("nil config must be inert and valid")
	}
}

func TestPot_BeforeAtAfterF(t *testing.T) {
	const F = 200000
	c := potCfg(F)
	cases := []struct {
		n    uint64
		want common.Address
	}{{0, potSealer}, {F - 1, potSealer}, {F, potPool}, {F + 1, potPool}, {1 << 40, potPool}}
	for _, tc := range cases {
		if got := c.RewardRecipient(tc.n, potSealer); got != tc.want {
			t.Fatalf("n=%d: recipient %s want %s", tc.n, got.Hex(), tc.want.Hex())
		}
	}
	// Split amounts are unchanged by the pot (2% fee both sides of F).
	gross := uint256.MustFromDecimal("2000000000000000000")
	for _, n := range []uint64{F - 1, F, F + 1} {
		fee, net := c.Split(n, gross)
		if fee.Uint64() != 40000000000000000 || net.Uint64() != 1960000000000000000 {
			t.Fatalf("n=%d split fee=%s net=%s", n, fee, net)
		}
	}
}

func TestPot_RoundingConserves(t *testing.T) {
	c := potCfg(50000)
	for _, g := range []string{"0", "1", "49", "50", "51", "99", "10001", "62500000000000000", "1937500000000000001", "2000000000000000000", "115792089237316195423570985008687907853269984665640564039457584007913129639"} {
		gross := uint256.MustFromDecimal(g)
		fee, net := c.Split(50000, gross)
		want := new(uint256.Int).Mul(gross, uint256.NewInt(200))
		want.Div(want, uint256.NewInt(BpsDenom))
		if fee.Cmp(want) != 0 {
			t.Fatalf("gross=%s fee=%s want floor %s", g, fee, want)
		}
		if new(uint256.Int).Add(fee, net).Cmp(gross) != 0 {
			t.Fatalf("gross=%s fee+net != gross (dust lost)", g)
		}
		// pot receives exactly net; sealer receives nothing
		if err := c.ValidateBlockPayout(50000, gross, fee, net); err != nil {
			t.Fatalf("exact payout rejected: %v", err)
		}
	}
}

func TestPot_ZeroAddressRejected(t *testing.T) {
	c := &Config{FeeBps: 200, FeeAddress: potTreasury, PotActivationBlock: u64p(100)}
	if err := c.Validate(); err != ErrNoPotAddress {
		t.Fatalf("Validate: got %v want ErrNoPotAddress", err)
	}
	g := uint256.NewInt(1000000)
	fee, net := c.Split(100, g)
	if err := c.ValidateBlockPayout(100, g, fee, net); err != ErrNoPotAddress {
		t.Fatalf("ValidateBlockPayout when active: got %v", err)
	}
	if err := c.ValidateBlockPayout(99, g, fee, net); err != nil {
		t.Fatalf("before F the pot rule must not apply: %v", err)
	}
}

func TestPot_ValidateBlockPayout(t *testing.T) {
	c := potCfg(50000)
	g := uint256.MustFromDecimal("2000000000000000000")
	fee, net := c.Split(50000, g)
	short := new(uint256.Int).Sub(net, uint256.NewInt(1))
	if err := c.ValidateBlockPayout(50000, g, fee, short); err != ErrPotShort {
		t.Fatalf("short pot: got %v", err)
	}
	if err := c.ValidateBlockPayout(50000, g, new(uint256.Int).Sub(fee, uint256.NewInt(1)), net); err != ErrFeeShort {
		t.Fatalf("short fee: got %v", err)
	}
	// before F: pot credit irrelevant (sealer is paid), fee rule still applies
	if err := c.ValidateBlockPayout(49999, g, fee, uint256.NewInt(0)); err != nil {
		t.Fatalf("before F: %v", err)
	}
}

func TestPot_GenesisJSON(t *testing.T) {
	// Legacy object (exactly what mainnet stores) must round-trip byte-identically.
	legacy := `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":40000}`
	var g GenesisConfig
	if err := json.Unmarshal([]byte(legacy), &g); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(&g)
	if string(out) != legacy {
		t.Fatalf("legacy re-encode changed:\n got %s\nwant %s", out, legacy)
	}
	if c := g.ToConfig(); c.PotActivationBlock != nil || c.PotAddress != (common.Address{}) {
		t.Fatal("legacy must decode with pot off")
	}
	withPot := `{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":40000,"potAddress":"0xbd749b16e83d0c81fbce8fc72005e81f3b3180ff","potActivationBlock":175000}`
	var g2 GenesisConfig
	if err := json.Unmarshal([]byte(withPot), &g2); err != nil {
		t.Fatal(err)
	}
	c := g2.ToConfig()
	if c.PotAddress != potPool || c.PotActivationBlock == nil || *c.PotActivationBlock != 175000 {
		t.Fatalf("pot fields not decoded: %+v", c)
	}
	*g2.PotActivationBlock = 1 // ToConfig must copy, not alias
	if *c.PotActivationBlock != 175000 {
		t.Fatal("ToConfig aliases genesis pointer")
	}
	out2, _ := json.Marshal(&g2)
	if string(out2) == legacy {
		t.Fatal("pot fields lost on re-encode")
	}
	// potActivationBlock without potAddress decodes (no error at decode — a decode error
	// would make rawdb.ReadChainConfig drop the stored config) but fails Validate.
	var g3 GenesisConfig
	_ = json.Unmarshal([]byte(`{"feeBps":200,"feeAddress":"0xf129608bf3ba681012cf82dffcfbb92563df987e","activationBlock":0,"potActivationBlock":5}`), &g3)
	if g3.ToConfig().Validate() != ErrNoPotAddress {
		t.Fatal("missing potAddress must fail Validate")
	}
}
