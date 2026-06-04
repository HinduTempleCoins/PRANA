const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const abi = ethers.AbiCoder.defaultAbiCoder();
const ZERO = ethers.ZeroHash;

// ── Leaf + tree helpers (mirror the Solidity encoding exactly) ──────────────
//   leaf = keccak256(abi.encode(uint8 position, uint8 cardId, bytes32 salt))
function deckLeaf(position, cardId, salt) {
  return ethers.keccak256(
    abi.encode(["uint8", "uint8", "bytes32"], [position, cardId, salt])
  );
}
// OZ MerkleProof sorted/commutative pair hash (single keccak over sorted concat).
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

// Build a Merkle tree over leaves[] (already in position order), no padding — exact OZ style.
function buildTree(leaves) {
  if (leaves.length === 1) return { root: leaves[0], layers: [leaves] };
  let level = leaves.slice();
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashPair(level[i], level[i + 1]));
      else next.push(level[i]); // odd node promoted (OZ convention)
    }
    level = next;
    layers.push(level);
  }
  return { root: level[0], layers };
}
// Proof for a leaf index against the (possibly-odd) tree built above.
function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sib = idx ^ 1;
    if (sib < layer.length) proof.push(layer[sib]);
    idx >>= 1;
  }
  return proof;
}

// Build a deck: cardId at position i. pairs[] is the cardId placed at each position.
// Returns { root, leaves, layers, salts, cards }.
function makeDeck(cards, tag = "d") {
  const salts = cards.map((_, i) =>
    ethers.keccak256(ethers.toUtf8Bytes(`${tag}:${i}`))
  );
  const leaves = cards.map((c, i) => deckLeaf(i, c, salts[i]));
  const { root, layers } = buildTree(leaves);
  return { root, leaves, layers, salts, cards };
}

// Adjacent-pairs deck: position 2k and 2k+1 both hold cardId k. Easiest to "match".
function adjacentDeck(pairCount, tag) {
  const cards = [];
  for (let k = 0; k < pairCount; k++) {
    cards.push(k, k);
  }
  return makeDeck(cards, tag);
}

function configFor(pairCount) {
  return abi.encode(["uint8"], [pairCount]);
}
function setupRoot(root) {
  return abi.encode(["bytes32"], [root]);
}
function setupAck() {
  return abi.encode(["bool"], [true]);
}
// Encode a PLAY move flipping positions pA and pB.
function flipMove(deck, pA, pB) {
  return abi.encode(
    ["uint8", "uint8", "bytes32", "bytes32[]", "uint8", "uint8", "bytes32", "bytes32[]"],
    [
      pA,
      deck.cards[pA],
      deck.salts[pA],
      proofFor(deck.layers, pA),
      pB,
      deck.cards[pB],
      deck.salts[pB],
      proofFor(deck.layers, pB),
    ]
  );
}

describe("EchoMatchRules (memory / pairs vs committed deck)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("EchoMatchRules");
    const rules = await F.deploy();
    return { rules };
  }

  it("rejects bad config (0 or > 32 pairs)", async () => {
    const { rules } = await loadFixture(deploy);
    await expect(
      rules.initialState(configFor(0), 2)
    ).to.be.revertedWithCustomError(rules, "BadConfig");
    await expect(
      rules.initialState(configFor(33), 2)
    ).to.be.revertedWithCustomError(rules, "BadConfig");
  });

  it("SETUP: dealer commits root, guesser acks, advances to PLAY", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = adjacentDeck(3, "s");
    let state = await rules.initialState(configFor(3), 2);
    expect(await rules.simultaneous(state)).to.equal(true);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());
    expect(await rules.simultaneous(state)).to.equal(false); // PLAY
    expect(await rules.status(state)).to.equal(0);
  });

  it("a matching flip scores; full game to terminal picks the higher score", async () => {
    const { rules } = await loadFixture(deploy);
    const N = 3;
    const deck = adjacentDeck(N, "g"); // pairs at (0,1),(2,3),(4,5)
    let state = await rules.initialState(configFor(N), 2);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());

    // p1 matches pair 0 (positions 0,1). No extra turn → p2 moves next.
    state = await rules.applyMove(state, 0, flipMove(deck, 0, 1));
    // p2 matches pair 1 (positions 2,3).
    state = await rules.applyMove(state, 1, flipMove(deck, 2, 3));
    // p1 matches pair 2 (positions 4,5) → all 3 pairs found, game ends.
    state = await rules.applyMove(state, 0, flipMove(deck, 4, 5));

    // p1 scored 2 pairs, p2 scored 1 → p1 wins.
    expect(await rules.status(state)).to.equal(1);
  });

  it("a tie is a draw (255)", async () => {
    const { rules } = await loadFixture(deploy);
    const N = 2;
    const deck = adjacentDeck(N, "t"); // pairs at (0,1),(2,3)
    let state = await rules.initialState(configFor(N), 2);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());
    state = await rules.applyMove(state, 0, flipMove(deck, 0, 1)); // p1 scores
    state = await rules.applyMove(state, 1, flipMove(deck, 2, 3)); // p2 scores → 1-1
    expect(await rules.status(state)).to.equal(255);
  });

  it("re-flipping an already-revealed (matched) position reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const N = 3;
    const deck = adjacentDeck(N, "r");
    let state = await rules.initialState(configFor(N), 2);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());
    state = await rules.applyMove(state, 0, flipMove(deck, 0, 1)); // matches, 0&1 revealed
    // p2 tries to flip position 0 again → PositionRevealed.
    await expect(
      rules.applyMove(state, 1, flipMove(deck, 0, 2))
    ).to.be.revertedWithCustomError(rules, "PositionRevealed");
  });

  it("flipping the same position twice in one move reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = adjacentDeck(3, "sp");
    let state = await rules.initialState(configFor(3), 2);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());
    await expect(
      rules.applyMove(state, 0, flipMove(deck, 2, 2))
    ).to.be.revertedWithCustomError(rules, "SamePosition");
  });

  it("fraud: a flip with a bad proof forfeits to the opponent", async () => {
    const { rules } = await loadFixture(deploy);
    const N = 3;
    const deck = adjacentDeck(N, "f");
    let state = await rules.initialState(configFor(N), 2);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());

    // p1 lies about position 0's card: claim cardId 9 (wrong) with the real salt/proof.
    const badMove = abi.encode(
      ["uint8", "uint8", "bytes32", "bytes32[]", "uint8", "uint8", "bytes32", "bytes32[]"],
      [
        0,
        9, // wrong card → leaf won't verify
        deck.salts[0],
        proofFor(deck.layers, 0),
        1,
        deck.cards[1],
        deck.salts[1],
        proofFor(deck.layers, 1),
      ]
    );
    state = await rules.applyMove(state, 0, badMove);
    // p1 (the mover, turn 0) committed fraud → p2 wins.
    expect(await rules.status(state)).to.equal(2);
  });

  it("moving out of turn reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const deck = adjacentDeck(3, "o");
    let state = await rules.initialState(configFor(3), 2);
    state = await rules.applyMove(state, 0, setupRoot(deck.root));
    state = await rules.applyMove(state, 1, setupAck());
    // It's p1's (turn 0) move; p2 tries → NotYourTurn.
    await expect(
      rules.applyMove(state, 1, flipMove(deck, 0, 1))
    ).to.be.revertedWithCustomError(rules, "NotYourTurn");
  });
});
