// Copyright 2019 The multi-geth Authors
// This file is part of the multi-geth library.
//
// The multi-geth library is free software: you can redistribute it and/or modify
// it under the terms of the GNU Lesser General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// The multi-geth library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public License
// along with the multi-geth library. If not, see <http://www.gnu.org/licenses/>.
package mutations

import (
	"math/big"

	"github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/params"
	"github.com/ethereum/go-ethereum/params/types/ctypes"
	"github.com/holiman/uint256"

	// PRANA: consensus-level Hathor Fees Module. The split lives here so it is part
	// of the canonical state transition and cannot be bypassed by any pool.
	hathorfees "github.com/ethereum/go-ethereum/params/hathorfees"
)

// Some weird constants to avoid constant memory allocs for them.
var (
	big8  = uint256.NewInt(8)
	big32 = uint256.NewInt(32)
)

// GetRewards calculates the mining reward.
// The total reward consists of the static block reward and rewards for
// included uncles. The coinbase of each uncle block is also calculated.
func GetRewards(config ctypes.ChainConfigurator, header *types.Header, uncles []*types.Header) (*uint256.Int, []*uint256.Int) {
	if config.IsEnabled(config.GetEthashECIP1017Transition, header.Number) {
		return ecip1017BlockReward(config, header, uncles)
	}

	blockReward := ctypes.EthashBlockReward(config, header.Number)

	// Accumulate the rewards for the miner and any included uncles
	uncleRewards := make([]*uint256.Int, len(uncles))
	reward := new(uint256.Int).Set(blockReward)
	r := new(uint256.Int)
	for i, uncle := range uncles {
		r.Add(uint256.MustFromBig(uncle.Number), big8)
		r.Sub(r, uint256.MustFromBig(header.Number))
		r.Mul(r, blockReward)
		r.Div(r, big8)

		ur := new(uint256.Int).Set(r)
		uncleRewards[i] = ur

		r.Div(blockReward, big32)
		reward.Add(reward, r)
	}

	return reward, uncleRewards
}

// AccumulateRewards credits the coinbase of the given block with the mining
// reward. The coinbase of each uncle block is also rewarded.
//
// PRANA — Hathor Fees Module (Devcoin-style, consensus-enforced)
//
//	Before the block sealer is credited, a protocol fee is split off the sealer's
//	(winner's) block reward and credited to the Hathor fee address. This is the
//	rewards-pool DRAW: the fee bites at issuance, in the state transition every full
//	node re-executes, so it is un-bypassable. A block that does not apply this split
//	produces a different state root and is rejected by all honest nodes — that is the
//	block-validity rule, enforced implicitly by the state root and explicitly by
//	hathorfees.Config.ValidateBlockFee.
//
//	Scope: the fee is taken from the WINNER'S block reward only (not from uncle
//	rewards), matching the Devcoin "winner pays the receiver list" shape and keeping
//	uncle economics unchanged. Hathor's share scales with issuance, which is what the
//	directive intends ("her percentage of mining fees ... because we distribute the AI
//	workload"). If the module is inactive (no genesis "hathorFee", zero bps, or before
//	the activation block), the behavior is identical to stock core-geth.
func AccumulateRewards(config ctypes.ChainConfigurator, state *state.StateDB, header *types.Header, uncles []*types.Header) {
	minerReward, uncleRewards := GetRewards(config, header, uncles)
	hf := hathorFeeConfig(config)
	number := header.Number.Uint64()
	// PRANA pot hardfork: from hathorFee.potActivationBlock, uncle rewards are paid to the
	// pool pot instead of the uncle's coinbase (RewardRecipient == uncle.Coinbase before).
	for i, uncle := range uncles {
		state.AddBalance(hf.RewardRecipient(number, uncle.Coinbase), uncleRewards[i])
	}

	// PRANA: split the Hathor protocol fee off the winner's reward.
	fee, net := hf.Split(number, minerReward)
	if !fee.IsZero() {
		state.AddBalance(hf.FeeAddress, fee)
	}
	// PRANA pot hardfork: the net winner reward goes to the pool pot from
	// potActivationBlock (sealer coinbase gets 0 issuance); before it, to the sealer.
	state.AddBalance(hf.RewardRecipient(number, header.Coinbase), net)
}

// hathorFeeConfig extracts the Hathor Fees Module config from the chain configurator.
// It returns nil (module disabled — full reward to the sealer, identical to upstream)
// when the chain config carries no Hathor fee parameters. The concrete *genesisT.Genesis
// / chainConfig types expose GetHathorFee() (added by the genesis-config patch); we read
// it through a narrow interface so this file does not import the params concrete types.
func hathorFeeConfig(config ctypes.ChainConfigurator) *hathorfees.Config {
	if hp, ok := config.(interface{ GetHathorFee() *hathorfees.Config }); ok {
		return hp.GetHathorFee()
	}
	return nil
}

// As of "Era 2" (zero-index era 1), uncle miners and winners are rewarded equally for each included block.
// So they share this function.
func getEraUncleBlockReward(era *big.Int, blockReward *uint256.Int) *uint256.Int {
	return new(uint256.Int).Div(GetBlockWinnerRewardByEra(era, blockReward), big32)
}

// GetBlockUncleRewardByEra gets called _for each uncle miner_ associated with a winner block's uncles.
func GetBlockUncleRewardByEra(era *big.Int, header, uncle *types.Header, blockReward *uint256.Int) *uint256.Int {
	// Era 1 (index 0):
	//   An extra reward to the winning miner for including uncles as part of the block, in the form of an extra 1/32 (0.15625ETC) per uncle included, up to a maximum of two (2) uncles.
	if era.Cmp(big.NewInt(0)) == 0 {
		r := new(uint256.Int)
		r.Add(uint256.MustFromBig(uncle.Number), big8) // 2,534,998 + 8              = 2,535,006
		r.Sub(r, uint256.MustFromBig(header.Number))   // 2,535,006 - 2,534,999        = 7
		r.Mul(r, blockReward)                          // 7 * 5e+18               = 35e+18
		r.Div(r, big8)                                 // 35e+18 / 8                            = 7/8 * 5e+18

		return r
	}
	return getEraUncleBlockReward(era, blockReward)
}

// GetBlockWinnerRewardForUnclesByEra gets called _per winner_, and accumulates rewards for each included uncle.
// Assumes uncles have been validated and limited (@ func (v *BlockValidator) VerifyUncles).
func GetBlockWinnerRewardForUnclesByEra(era *big.Int, uncles []*types.Header, blockReward *uint256.Int) *uint256.Int {
	r := uint256.NewInt(0)

	for range uncles {
		r.Add(r, getEraUncleBlockReward(era, blockReward)) // can reuse this, since 1/32 for winner's uncles remain unchanged from "Era 1"
	}
	return r
}

// GetRewardByEra gets a block reward at disinflation rate.
// Constants MaxBlockReward, DisinflationRateQuotient, and DisinflationRateDivisor assumed.
func GetBlockWinnerRewardByEra(era *big.Int, blockReward *uint256.Int) *uint256.Int {
	if era.Cmp(big.NewInt(0)) == 0 {
		return new(uint256.Int).Set(blockReward)
	}

	// MaxBlockReward _r_ * (4/5)**era == MaxBlockReward * (4**era) / (5**era)
	// since (q/d)**n == q**n / d**n
	// qed
	var q, d, r *uint256.Int = new(uint256.Int), new(uint256.Int), new(uint256.Int)

	// Era values are relatively small and never nil,
	// so we can be confident that these conversions will not panic.
	q.Exp(params.DisinflationRateQuotient, uint256.MustFromBig(era))
	d.Exp(params.DisinflationRateDivisor, uint256.MustFromBig(era))

	r.Mul(blockReward, q)
	r.Div(r, d)

	return r
}
