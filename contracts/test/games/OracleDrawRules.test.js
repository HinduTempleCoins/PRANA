const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ───────────────────────── Merkle helpers (mirror the Solidity leaf scheme) ────────────────
// Leaf: keccak256(bytes.concat(keccak256(abi.encode(uint8 index, uint8 card, bytes32 salt)))).
const coder = ethers.AbiCoder.defaultAbiCoder();

function leafHash(index, card, salt) {
  const inner = ethers.keccak256(coder.encode(["uint8", "uint8", "bytes32"], [index, card, salt]));
  return ethers.keccak256(inner);
}
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}
function buildTree(leaves) {
  let layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  function proof(index) {
    const p = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l];
      const pair = idx ^ 1;
      if (pair < layer.length) p.push(layer[pair]);
      idx = Math.floor(idx / 2);
    }
    return p;
  }
  return { root: layers[layers.length - 1][0], proof };
}

// Commit a deck: `cards` is an array of 52 card values 0..51 in deck order.
function commitDeck(cards) {
  const salts = cards.map((_, i) => ethers.id(`deck-salt-${i}`));
  const leaves = cards.map((c, i) => leafHash(i, c, salts[i]));
  const tree = buildTree(leaves);
  const reveal = (i) => coder.encode(
    ["uint8", "uint8", "bytes32", "bytes32[]"],
    [i, cards[i], salts[i], tree.proof(i)]
  );
  return { root: tree.root, cards, salts, tree, reveal };
}

const RANK = (card) => card % 13;
const encRoot = (root) => coder.encode(["bytes32"], [root]);
const encCall = (higher) => coder.encode(["bool"], [higher]);

describe("OracleDrawRules (committer-vs-guesser hi-lo)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("OracleDrawRules");
    const rules = await F.deploy();
    return { rules };
  }

  // A standard ordered deck 0..51 (card == index here for simplicity).
  function orderedDeck() {
    return Array.from({ length: 52 }, (_, i) => i);
  }

  it("initialState rejects non-2 players and out-of-range rounds", async () => {
    const { rules } = await loadFixture(deploy);
    await expect(rules.initialState("0x", 2 + 1)).to.be.revertedWithCustomError(rules, "UnsupportedPlayerCount");
    await expect(rules.initialState(coder.encode(["uint8"], [0]), 2)).to.be.revertedWithCustomError(
      rules,
      "InvalidConfig"
    );
    await expect(rules.initialState(coder.encode(["uint8"], [52]), 2)).to.be.revertedWithCustomError(
      rules,
      "InvalidConfig"
    );
  });

  it("happy path: guesser calls every round correctly ⇒ guesser wins (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = commitDeck(orderedDeck()); // ranks: 0,1,2,...,12,0,1,... -> strictly rising within a suit
    const rounds = 5;
    let state = await rules.initialState(coder.encode(["uint8"], [rounds]), 2);
    state = await rules.applyMove(state, 0, encRoot(deck.root));
    state = await rules.applyMove(state, 0, deck.reveal(0)); // prime with index 0 (rank 0)

    let face = deck.cards[0];
    for (let r = 1; r <= rounds; r++) {
      const next = deck.cards[r];
      const higher = RANK(next) > RANK(face); // correct call
      state = await rules.applyMove(state, 1, encCall(higher));
      state = await rules.applyMove(state, 0, deck.reveal(r));
      face = next;
    }
    expect(await rules.status(state)).to.equal(2n); // guesser swept
  });

  it("guesser calls every round wrong ⇒ dealer wins (status 1)", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = commitDeck(orderedDeck());
    const rounds = 5;
    let state = await rules.initialState(coder.encode(["uint8"], [rounds]), 2);
    state = await rules.applyMove(state, 0, encRoot(deck.root));
    state = await rules.applyMove(state, 0, deck.reveal(0));

    let face = deck.cards[0];
    for (let r = 1; r <= rounds; r++) {
      const next = deck.cards[r];
      const higher = !(RANK(next) > RANK(face)); // deliberately wrong
      state = await rules.applyMove(state, 1, encCall(higher));
      state = await rules.applyMove(state, 0, deck.reveal(r));
      face = next;
    }
    expect(await rules.status(state)).to.equal(1n);
  });

  it("equal-rank rounds push (no score change) and tie ⇒ draw (status 255)", async () => {
    const { rules } = await loadFixture(deploy);
    // Deck where face and every "next" share the same rank ⇒ every round pushes.
    // ranks repeat each 13 cards: indices 0 (rank0) and 13 (rank0), 26 (rank0)...
    const cards = [0, 13, 26, 39, 1, 14]; // ranks: 0,0,0,0,1,1
    const padded = cards.concat(orderedDeck().filter((c) => !cards.includes(c)));
    const deck = commitDeck(padded);
    const rounds = 3; // rounds 1..3 compare rank0 vs rank0 ⇒ all push
    let state = await rules.initialState(coder.encode(["uint8"], [rounds]), 2);
    state = await rules.applyMove(state, 0, encRoot(deck.root));
    state = await rules.applyMove(state, 0, deck.reveal(0));
    for (let r = 1; r <= rounds; r++) {
      state = await rules.applyMove(state, 1, encCall(true));
      state = await rules.applyMove(state, 0, deck.reveal(r));
    }
    expect(await rules.status(state)).to.equal(255n); // 0-0 ⇒ draw
  });

  it("FRAUD: revealing the same card value twice ⇒ guesser wins (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    // Build a deck whose index 1 holds the SAME card value as index 0 ⇒ duplicate on reveal.
    const cards = orderedDeck();
    cards[1] = cards[0]; // duplicate card 0 at index 1
    const deck = commitDeck(cards);
    let state = await rules.initialState(coder.encode(["uint8"], [3]), 2);
    state = await rules.applyMove(state, 0, encRoot(deck.root));
    state = await rules.applyMove(state, 0, deck.reveal(0)); // sees card 0
    state = await rules.applyMove(state, 1, encCall(true));
    state = await rules.applyMove(state, 0, deck.reveal(1)); // card 0 again ⇒ fraud
    expect(await rules.status(state)).to.equal(2n);
  });

  it("a reveal with a bad proof reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = commitDeck(orderedDeck());
    let state = await rules.initialState(coder.encode(["uint8"], [3]), 2);
    state = await rules.applyMove(state, 0, encRoot(deck.root));
    // Wrong card value for index 0 (claims card 5 at index 0) ⇒ proof fails.
    const bad = coder.encode(["uint8", "uint8", "bytes32", "bytes32[]"], [0, 5, deck.salts[0], deck.tree.proof(0)]);
    await expect(rules.applyMove(state, 0, bad)).to.be.revertedWithCustomError(rules, "BadProof");
  });

  it("wrong player ordering reverts (guesser cannot prime, dealer cannot call)", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = commitDeck(orderedDeck());
    let state = await rules.initialState(coder.encode(["uint8"], [3]), 2);
    await expect(rules.applyMove(state, 1, encRoot(deck.root))).to.be.revertedWithCustomError(rules, "NotYourTurn");
    state = await rules.applyMove(state, 0, encRoot(deck.root));
    state = await rules.applyMove(state, 0, deck.reveal(0));
    await expect(rules.applyMove(state, 0, encCall(true))).to.be.revertedWithCustomError(rules, "NotYourTurn");
  });
});
