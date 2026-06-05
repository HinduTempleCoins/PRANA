// Copyright 2026 The PRANA / Van Kush Family Research Institute Authors.
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Package hathorfees implements the PRANA Hathor Fees Module: a CONSENSUS-LEVEL,
// un-bypassable protocol fee on block issuance, modeled on the Devcoin "receiver"
// pattern where a fraction of every block's coinbase is paid, by protocol rule, to a
// governed beneficiary rather than to whoever sealed the block.
//
// WHY THIS LIVES IN THE CONSENSUS LAYER (not in a contract)
//
//	The application-layer Hathor skim (contracts/compute/SettlementFeeHook.sol +
//	HathorFeeTreasury.sol) only bites when value is paid OUT of the on-chain
//	UnifiedSharesLedger. A third party who runs their OWN pool, never touches our
//	ledger, and settles miners off-chain would pay no skim there. The operator's
//	requirement (directive 2026-06-05, Addendum 7) is stronger: "no matter how we or
//	they do it, Hathor always gets her Percentage of Mining Fees." The only place an
//	EVM PoW chain can guarantee that against ALL pools — including ones we never wrote
//	and never see — is the block-reward distribution itself, because every full node
//	re-derives it and rejects any block whose state transition does not apply it.
//
//	So the fee is taken at the REWARDS-POOL DRAW (the moment the chain issues new
//	PRANA into a coinbase), not at any pool's internal accounting. A pool that pays its
//	members off-chain does not avoid the fee, because the PRANA it is distributing was
//	already debited at issuance: the coinbase it received was net-of-Hathor-fee by
//	consensus, and the Hathor share was credited to the fee address in the same state
//	transition. There is no PRANA in existence that did not already pay the fee at the
//	moment it was minted.
//
// ENFORCEMENT MODEL (the Devcoin lesson, made un-bypassable)
//
//	The fee is applied inside AccumulateRewards, which is part of the canonical state
//	transition. The resulting account balances feed header.Root (the state root) in
//	Finalize. A miner who omits or short-pays the Hathor fee produces a DIFFERENT state
//	root than honest nodes compute for the same block, so every honest validator's
//	stateless re-execution rejects the block as invalid. The fee is therefore not
//	"requested" — it is a block-validity rule. ValidateBlockFee() makes the same check
//	explicit for callers that want to assert it directly (e.g. a verifier or a test).
//
// This package is consensus-critical: a change to Split() is a hard fork.
package hathorfees

import (
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"
)

// BpsDenom is the basis-points denominator. A fee of 500 bps == 5.00%.
const BpsDenom = 10000

// Errors returned by validation.
var (
	// ErrFeeShort is returned when a block credited the Hathor address less than the
	// protocol-required fee for its issuance. Such a block is invalid.
	ErrFeeShort = errors.New("hathorfees: block underpays the Hathor protocol fee")
	// ErrNoFeeAddress is returned when the module is active but the configured fee
	// address is the zero address (misconfiguration; would burn the fee).
	ErrNoFeeAddress = errors.New("hathorfees: active fee but zero fee address")
)

// Config is the consensus parameter set for the Hathor Fees Module. It is read from
// the chain config (genesis "hathorFee" block — see chain/genesis/prana.genesis.json
// and chain/hathorfees/config.go) and is identical on every node by construction; a
// node that runs different values forks itself off the network.
//
// Config carries no governance authority of its own. The FeeAddress is intended to be
// the HathorFeeTreasury contract (which never trades and only disburses by DAO
// timelock). The BPS rate is a launch-pinned protocol constant; changing it is a
// hard fork (a future RateTransitions schedule can encode planned changes the same way
// EthashBlockRewardSchedule encodes reward changes — left as a documented extension).
type Config struct {
	// FeeBps is Hathor's share of each block's gross issuance, in basis points.
	// 0 disables the module (no fee taken, no validity rule applied).
	FeeBps uint64
	// FeeAddress is the protocol beneficiary — Hathor's fee sink. Intended: the
	// HathorFeeTreasury contract address. Must be non-zero when FeeBps > 0.
	FeeAddress common.Address
	// ActivationBlock is the first block number at which the fee applies. Before it,
	// the module is inert (lets a chain launch and turn the fee on at a known height).
	ActivationBlock uint64
}

// Active reports whether the module takes a fee for a block at height `number`.
func (c *Config) Active(number uint64) bool {
	if c == nil || c.FeeBps == 0 {
		return false
	}
	return number >= c.ActivationBlock
}

// Split divides a gross block issuance into the Hathor protocol fee and the net amount
// that the miner (block sealer) actually receives. It is the single source of truth for
// the split and is used both when CREDITING rewards (AccumulateRewards) and when
// VALIDATING a block (ValidateBlockFee), so the two can never diverge.
//
//	fee = gross * FeeBps / BpsDenom   (integer floor; dust below 1 wei-per-bps stays with miner)
//	net = gross - fee
//
// If the module is inactive for `number`, fee is zero and net == gross.
func (c *Config) Split(number uint64, gross *uint256.Int) (fee, net *uint256.Int) {
	net = new(uint256.Int).Set(gross)
	fee = new(uint256.Int) // zero
	if !c.Active(number) {
		return fee, net
	}
	// fee = gross * FeeBps / BpsDenom, all in uint256 to match EVM balance math.
	fee = new(uint256.Int).Mul(gross, uint256.NewInt(c.FeeBps))
	fee.Div(fee, uint256.NewInt(BpsDenom))
	net = new(uint256.Int).Sub(gross, fee)
	return fee, net
}

// RequiredFee returns just the Hathor fee owed on a gross issuance at height `number`.
// Convenience wrapper used by the block-validity check.
func (c *Config) RequiredFee(number uint64, gross *uint256.Int) *uint256.Int {
	fee, _ := c.Split(number, gross)
	return fee
}

// ValidateBlockFee asserts that `creditedToHathor` (the amount the block actually paid
// to the Hathor fee address out of this block's issuance) is at least the protocol-
// required fee for `gross` at height `number`. It returns ErrFeeShort otherwise.
//
// This is the explicit form of the rule that the state root already enforces
// implicitly: a block that credits less than RequiredFee to the fee address is invalid.
// Consensus code calls this; so do the tests. Overpayment is permitted (a miner may
// donate more) — only underpayment is rejected.
func (c *Config) ValidateBlockFee(number uint64, gross, creditedToHathor *uint256.Int) error {
	if !c.Active(number) {
		return nil
	}
	if c.FeeAddress == (common.Address{}) {
		return ErrNoFeeAddress
	}
	required := c.RequiredFee(number, gross)
	if creditedToHathor.Cmp(required) < 0 {
		return ErrFeeShort
	}
	return nil
}

// SplitBig is a *big.Int convenience facade over Split for callers outside the
// uint256 balance path (tooling, the off-chain Bot mirror).
func (c *Config) SplitBig(number uint64, gross *big.Int) (fee, net *big.Int) {
	g, overflow := uint256.FromBig(gross)
	if overflow {
		// Should never happen for a block reward; be safe and treat as no-fee.
		return big.NewInt(0), new(big.Int).Set(gross)
	}
	f, n := c.Split(number, g)
	return f.ToBig(), n.ToBig()
}
