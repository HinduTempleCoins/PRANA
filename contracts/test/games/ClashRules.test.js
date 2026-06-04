const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ROCK = 0, PAPER = 1, SCISSORS = 2;
const PHASE_COMMIT = 0, PHASE_REVEAL = 1;

const abi = ethers.AbiCoder.defaultAbiCoder();

// State tuple layout (mirrors ClashRules.S / its encoding).
const STATE_TYPES = [
  "uint8", "uint8", "uint8", "uint8",
  "bool", "bool", "bool", "bool",
  "bytes32", "bytes32", "uint8", "uint8",
  "bool", "bool",
];

function decode(state) {
  const d = abi.decode(STATE_TYPES, state);
  return {
    n: Number(d[0]), phase: Number(d[1]), scoreP0: Number(d[2]), scoreP1: Number(d[3]),
    committed0: d[4], committed1: d[5], revealed0: d[6], revealed1: d[7],
    commit0: d[8], commit1: d[9], choice0: Number(d[10]), choice1: Number(d[11]),
    bad0: d[12], bad1: d[13],
  };
}

const SALT0 = ethers.id("salt-p0");
const SALT1 = ethers.id("salt-p1");

function commitMove(choice, salt) {
  const commitment = ethers.keccak256(abi.encode(["uint8", "bytes32"], [choice, salt]));
  return abi.encode(["bytes32"], [commitment]);
}

function revealMove(choice, salt) {
  return abi.encode(["uint8", "bytes32"], [choice, salt]);
}

describe("ClashRules", function () {
  async function deployFixture() {
    const Factory = await ethers.getContractFactory("ClashRules");
    const rules = await Factory.deploy();
    await rules.waitForDeployment();
    return { rules };
  }

  // Play one full round (commit both, reveal both) and return resulting state.
  async function playRound(rules, state, c0, s0, c1, s1) {
    state = await rules.applyMove(state, 0, commitMove(c0, s0));
    state = await rules.applyMove(state, 1, commitMove(c1, s1));
    // now in reveal phase
    state = await rules.applyMove(state, 0, revealMove(c0, s0));
    state = await rules.applyMove(state, 1, revealMove(c1, s1));
    return state;
  }

  it("metadata + player bounds", async () => {
    const { rules } = await loadFixture(deployFixture);
    expect(await rules.gameName()).to.equal("Clash");
    expect(await rules.minPlayers()).to.equal(2);
    expect(await rules.maxPlayers()).to.equal(2);
  });

  it("initialState defaults to best-of-3, commit phase, simultaneous", async () => {
    const { rules } = await loadFixture(deployFixture);
    const state = await rules.initialState("0x", 2);
    const s = decode(state);
    expect(s.n).to.equal(3);
    expect(s.phase).to.equal(PHASE_COMMIT);
    expect(s.scoreP0).to.equal(0);
    expect(s.scoreP1).to.equal(0);
    expect(await rules.simultaneous(state)).to.equal(true);
    expect(await rules.status(state)).to.equal(0);
  });

  it("rejects non-2 player counts and even/zero N", async () => {
    const { rules } = await loadFixture(deployFixture);
    await expect(rules.initialState("0x", 3)).to.be.revertedWithCustomError(rules, "UnsupportedPlayerCount");
    const cfgEven = abi.encode(["uint8"], [4]);
    await expect(rules.initialState(cfgEven, 2)).to.be.revertedWithCustomError(rules, "InvalidConfig");
    const cfgZero = abi.encode(["uint8"], [0]);
    await expect(rules.initialState(cfgZero, 2)).to.be.revertedWithCustomError(rules, "InvalidConfig");
  });

  it("custom odd N from config", async () => {
    const { rules } = await loadFixture(deployFixture);
    const state = await rules.initialState(abi.encode(["uint8"], [5]), 2);
    expect(decode(state).n).to.equal(5);
  });

  it("phase flips to reveal only after BOTH commit", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, commitMove(ROCK, SALT0));
    expect(decode(state).phase).to.equal(PHASE_COMMIT);
    expect(decode(state).committed0).to.equal(true);
    state = await rules.applyMove(state, 1, commitMove(SCISSORS, SALT1));
    expect(decode(state).phase).to.equal(PHASE_REVEAL);
  });

  it("double-commit by same player reverts", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, commitMove(ROCK, SALT0));
    await expect(rules.applyMove(state, 0, commitMove(PAPER, SALT0)))
      .to.be.revertedWithCustomError(rules, "AlreadyActed");
  });

  it("bad player index reverts", async () => {
    const { rules } = await loadFixture(deployFixture);
    const state = await rules.initialState("0x", 2);
    await expect(rules.applyMove(state, 2, commitMove(ROCK, SALT0)))
      .to.be.revertedWithCustomError(rules, "BadPlayerIndex");
  });

  it("standard RPS round winner: rock beats scissors (p0 wins)", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await playRound(rules, state, ROCK, SALT0, SCISSORS, SALT1);
    const s = decode(state);
    expect(s.scoreP0).to.equal(1);
    expect(s.scoreP1).to.equal(0);
    expect(s.phase).to.equal(PHASE_COMMIT); // re-armed for next round
  });

  it("tie round is void (replay, no point), board re-armed", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await playRound(rules, state, PAPER, SALT0, PAPER, SALT1);
    const s = decode(state);
    expect(s.scoreP0).to.equal(0);
    expect(s.scoreP1).to.equal(0);
    expect(s.phase).to.equal(PHASE_COMMIT);
  });

  it("bad reveal (wrong salt) forfeits the round to the other player", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    // p0 commits ROCK, p1 commits ROCK (would tie), but p1 reveals with wrong salt.
    state = await rules.applyMove(state, 0, commitMove(ROCK, SALT0));
    state = await rules.applyMove(state, 1, commitMove(ROCK, SALT1));
    state = await rules.applyMove(state, 0, revealMove(ROCK, SALT0));
    state = await rules.applyMove(state, 1, revealMove(ROCK, ethers.id("wrong")));
    const s = decode(state);
    expect(s.scoreP0).to.equal(1); // p0 wins the round by p1's forfeit
    expect(s.scoreP1).to.equal(0);
  });

  it("bad reveal (out-of-range choice) forfeits the round", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    // p0 commits choice=5 with matching hash, but 5 is out of range -> bad.
    const badCommit = ethers.keccak256(abi.encode(["uint8", "bytes32"], [5, SALT0]));
    state = await rules.applyMove(state, 0, abi.encode(["bytes32"], [badCommit]));
    state = await rules.applyMove(state, 1, commitMove(ROCK, SALT1));
    state = await rules.applyMove(state, 0, revealMove(5, SALT0));
    state = await rules.applyMove(state, 1, revealMove(ROCK, SALT1));
    const s = decode(state);
    expect(s.scoreP1).to.equal(1); // p1 wins by p0 forfeit
    expect(s.scoreP0).to.equal(0);
  });

  it("both-bad reveals void the round (no point to either)", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, commitMove(ROCK, SALT0));
    state = await rules.applyMove(state, 1, commitMove(PAPER, SALT1));
    state = await rules.applyMove(state, 0, revealMove(ROCK, ethers.id("x")));
    state = await rules.applyMove(state, 1, revealMove(PAPER, ethers.id("y")));
    const s = decode(state);
    expect(s.scoreP0).to.equal(0);
    expect(s.scoreP1).to.equal(0);
    expect(s.phase).to.equal(PHASE_COMMIT);
  });

  it("full best-of-3: p0 wins 2-0, status terminal", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await playRound(rules, state, ROCK, SALT0, SCISSORS, SALT1); // p0
    expect(await rules.status(state)).to.equal(0);
    state = await playRound(rules, state, PAPER, SALT0, ROCK, SALT1); // p0
    const s = decode(state);
    expect(s.scoreP0).to.equal(2);
    expect(await rules.status(state)).to.equal(1); // player 0 (1-based) won
  });

  it("full best-of-3: goes to deciding round, p1 wins 2-1", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await playRound(rules, state, ROCK, SALT0, SCISSORS, SALT1); // p0: 1-0
    state = await playRound(rules, state, ROCK, SALT0, PAPER, SALT1); // p1: 1-1
    expect(await rules.status(state)).to.equal(0);
    state = await playRound(rules, state, SCISSORS, SALT0, ROCK, SALT1); // p1: 1-2
    const s = decode(state);
    expect(s.scoreP0).to.equal(1);
    expect(s.scoreP1).to.equal(2);
    expect(await rules.status(state)).to.equal(2);
  });

  it("void rounds do not advance score; match still resolvable", async () => {
    const { rules } = await loadFixture(deployFixture);
    let state = await rules.initialState("0x", 2);
    state = await playRound(rules, state, ROCK, SALT0, ROCK, SALT1); // tie void
    expect(decode(state).scoreP0).to.equal(0);
    state = await playRound(rules, state, ROCK, SALT0, SCISSORS, SALT1); // p0
    state = await playRound(rules, state, SCISSORS, SALT0, PAPER, SALT1); // p0
    expect(await rules.status(state)).to.equal(1);
  });
});
