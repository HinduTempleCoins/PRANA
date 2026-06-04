// faucet-sink.js — reusable test-lib for the PRANA "every emission has a paired sink"
// discipline (CLAUDE.md: faucet/sink conservation).
//
// The conservation law we assert, for a single reward token T:
//
//     sum(faucet.totalEmitted())  -  sum(sink.totalAbsorbed())  ==  T.totalSupply() - supply0
//
// i.e. the NET change in the reward token's circulating supply over an activity window
// equals exactly (everything ever minted by the faucets) minus (everything ever burned by
// the sinks). No mint without an accounted faucet; no burn without an accounted sink.
//
// `buildEconomy(fixtures)` wraps the REAL contracts in thin adapters that read each
// contract's own on-chain accounting getters:
//   FAUCETS (mint POL via MINTER_ROLE):
//     - DelegationMint        -> emitted = POL.totalSupply attributable here is read via the
//                                token; DelegationMint has no cumulative-minted getter, so we
//                                track emissions by diffing the reward token across claims
//                                (the adapter exposes a measured accumulator).
//     - CitizenMissionPath    -> same (no getter): measured accumulator.
//     - EmissionScheduler     -> totalMinted() (has a getter).
//   SINKS (burn the token, reducing supply):
//     - BurnMine              -> NOTE: BurnMine burns its INPUT token and MINTS the reward
//                                token, so against the REWARD token it is a FAUCET, not a sink.
//                                Its totalMinted() is the emitted amount.
//     - UsageBurn             -> totalBurned()
//     - AccessGate            -> (no getter) measured accumulator
//     - FeeCollectorBurner    -> totalBurned()
//     - CreatureBreeding      -> (no getter) measured accumulator (breed-fee burns)
//
// Because several real contracts expose no cumulative getter, the lib's adapters accept an
// optional `measured()` thunk returning a bigint the test maintains; where a getter exists we
// prefer it. Each adapter is { name, kind, totalEmitted()|totalAbsorbed() } returning a
// Promise<bigint>, uniform regardless of source.

const { ethers } = require("hardhat");

// ---- mulberry32: the house seeded PRNG (matches the other invariant tests) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toBig = async (v) => BigInt(await v);

// --------------------------------------------------------------------------- //
//  Adapter factories                                                          //
// --------------------------------------------------------------------------- //

// A faucet adapter: reports cumulative tokens MINTED of the reward token.
//   source: either { contract, getter } (calls contract[getter]()) OR { measured }
//   (a thunk returning a bigint the harness maintains for contracts with no getter).
function faucet(name, source) {
  return {
    name,
    kind: "faucet",
    async totalEmitted() {
      if (source.measured) return BigInt(source.measured());
      return toBig(source.contract[source.getter]());
    },
  };
}

// A sink adapter: reports cumulative tokens BURNED (removed) of the reward token.
function sink(name, source) {
  return {
    name,
    kind: "sink",
    async totalAbsorbed() {
      if (source.measured) return BigInt(source.measured());
      return toBig(source.contract[source.getter]());
    },
  };
}

// --------------------------------------------------------------------------- //
//  buildEconomy                                                               //
// --------------------------------------------------------------------------- //
// fixtures: {
//   rewardToken,                      // the ERC-20 whose supply we conserve (e.g. PoLToken)
//   supply0,                          // bigint: rewardToken.totalSupply() at window start
//   faucets: [ {name, contract, getter} | {name, measured} ],
//   sinks:   [ {name, contract, getter} | {name, measured} ],
// }
function buildEconomy(fixtures) {
  const faucets = (fixtures.faucets || []).map((f) =>
    faucet(f.name, f.measured ? { measured: f.measured } : { contract: f.contract, getter: f.getter })
  );
  const sinks = (fixtures.sinks || []).map((s) =>
    sink(s.name, s.measured ? { measured: s.measured } : { contract: s.contract, getter: s.getter })
  );
  return { rewardToken: fixtures.rewardToken, supply0: BigInt(fixtures.supply0), faucets, sinks };
}

// --------------------------------------------------------------------------- //
//  Conservation runner                                                        //
// --------------------------------------------------------------------------- //
// Returns the three quantities and the residual; callers assert residual === 0n.
async function checkConservation(economy) {
  let emitted = 0n;
  for (const f of economy.faucets) emitted += await f.totalEmitted();

  let absorbed = 0n;
  for (const s of economy.sinks) absorbed += await s.totalAbsorbed();

  const supplyNow = BigInt(await economy.rewardToken.totalSupply());
  const supplyDelta = supplyNow - economy.supply0;

  // conservation: emitted - absorbed == supplyDelta  =>  residual == 0
  const residual = emitted - absorbed - supplyDelta;
  return { emitted, absorbed, supplyDelta, residual };
}

module.exports = {
  mulberry32,
  buildEconomy,
  faucet,
  sink,
  checkConservation,
};
