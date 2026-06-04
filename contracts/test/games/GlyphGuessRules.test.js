const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ───────────────────────── Merkle helpers (mirror the Solidity leaf scheme) ────────────────
// Leaf for GlyphGuess: keccak256(bytes.concat(keccak256(abi.encode(uint8 position, uint8 letter,
// bytes32 salt)))) — the OZ StandardMerkleTree double-hash leaf; OZ MerkleProof hashes pairs
// sorted (commutative), so our tree must do the same.
const coder = ethers.AbiCoder.defaultAbiCoder();

function leafHash(position, letter, salt) {
  const inner = ethers.keccak256(coder.encode(["uint8", "uint8", "bytes32"], [position, letter, salt]));
  return ethers.keccak256(inner);
}
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}
// Build a sorted-pair Merkle tree over `leaves`; returns { root, proof(i) }.
function buildTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, proof: () => [] };
  let layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];
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
  return { root, proof };
}

const LETTER = (ch) => ch.charCodeAt(0) - 97; // 'a' -> 0

// Build a committed word: returns { length, root, discloseFor(letterCode) -> Disclosure[] }.
function commitWord(word) {
  const codes = [...word].map(LETTER);
  const salts = codes.map((_, i) => ethers.id(`salt-${word}-${i}`));
  const leaves = codes.map((c, i) => leafHash(i, c, salts[i]));
  const tree = buildTree(leaves);
  function discloseFor(letterCode, onlyPositions) {
    const items = [];
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] !== letterCode) continue;
      if (onlyPositions && !onlyPositions.includes(i)) continue;
      items.push({ position: i, letter: codes[i], salt: salts[i], proof: tree.proof(i) });
    }
    return items;
  }
  // Disclosure for every still-unrevealed position (used by the FINAL move).
  function discloseAll(revealedPositions) {
    const items = [];
    for (let i = 0; i < codes.length; i++) {
      if (revealedPositions.includes(i)) continue;
      items.push({ position: i, letter: codes[i], salt: salts[i], proof: tree.proof(i) });
    }
    return items;
  }
  return { length: codes.length, root: tree.root, codes, discloseFor, discloseAll };
}

const DISC_T = "tuple(uint8 position, uint8 letter, bytes32 salt, bytes32[] proof)[]";
const encDisc = (items) => coder.encode([DISC_T], [items]);
const encSetup = (len, root) => coder.encode(["uint8", "bytes32"], [len, root]);
const encGuess = (letter) => coder.encode(["uint8"], [letter]);

describe("GlyphGuessRules (committer-vs-guesser hangman)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("GlyphGuessRules");
    const rules = await F.deploy();
    return { rules };
  }

  // Drive a full game given a word and an ordered list of guessed letters.
  async function playGuesses(rules, word, guesses, maxWrong) {
    const w = commitWord(word);
    const cfg = maxWrong === undefined ? "0x" : coder.encode(["uint8"], [maxWrong]);
    let state = await rules.initialState(cfg, 2);
    state = await rules.applyMove(state, 0, encSetup(w.length, w.root));
    const revealed = [];
    for (const ch of guesses) {
      const code = LETTER(ch);
      state = await rules.applyMove(state, 1, encGuess(code));
      const items = w.discloseFor(code);
      for (const it of items) revealed.push(it.position);
      state = await rules.applyMove(state, 0, encDisc(items));
      if ((await rules.status(state)) !== 0n) break;
    }
    return { state, w, revealed };
  }

  it("setup reverts on out-of-range word length", async () => {
    const { rules } = await loadFixture(deploy);
    let state = await rules.initialState("0x", 2);
    const w = commitWord("ab"); // length 2 < MIN_LEN
    await expect(rules.applyMove(state, 0, encSetup(2, w.root))).to.be.revertedWithCustomError(
      rules,
      "BadWordLength"
    );
  });

  it("initialState rejects non-2 player counts and maxWrong=0", async () => {
    const { rules } = await loadFixture(deploy);
    await expect(rules.initialState("0x", 3)).to.be.revertedWithCustomError(rules, "UnsupportedPlayerCount");
    await expect(rules.initialState(coder.encode(["uint8"], [0]), 2)).to.be.revertedWithCustomError(
      rules,
      "InvalidConfig"
    );
  });

  it("happy path: guesser reveals the whole word before maxWrong ⇒ guesser wins (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    // word "cat": c,a,t distinct. Guess c,a,t with no wrong letters.
    const { state } = await playGuesses(rules, "cat", ["c", "a", "t"], 6);
    expect(await rules.status(state)).to.equal(2n);
  });

  it("repeated letters: one disclosure of a letter reveals all its positions", async () => {
    const { rules } = await loadFixture(deploy);
    // "anna": a@0,a@3 ; n@1,n@2. Two guesses fully reveal the 4-letter word.
    const { state } = await playGuesses(rules, "anna", ["a", "n"], 6);
    expect(await rules.status(state)).to.equal(2n);
  });

  it("wrong guesses accumulate; reaching maxWrong then a consistent FINAL ⇒ committer wins (status 1)", async () => {
    const { rules } = await loadFixture(deploy);
    const w = commitWord("cat");
    let state = await rules.initialState(coder.encode(["uint8"], [2]), 2); // maxWrong = 2
    state = await rules.applyMove(state, 0, encSetup(w.length, w.root));

    // Two wrong letters (x, z) ⇒ phase goes to FINAL.
    for (const ch of ["x", "z"]) {
      state = await rules.applyMove(state, 1, encGuess(LETTER(ch)));
      state = await rules.applyMove(state, 0, encDisc(w.discloseFor(LETTER(ch)))); // empty arrays
    }
    expect(await rules.status(state)).to.equal(0n); // not decided yet — FINAL pending

    // FINAL: committer reveals every (still-unrevealed = all) position consistently.
    state = await rules.applyMove(state, 0, encDisc(w.discloseAll([])));
    expect(await rules.status(state)).to.equal(1n);
  });

  it("FRAUD: FINAL with a missing position ⇒ guesser wins (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    const w = commitWord("cat");
    let state = await rules.initialState(coder.encode(["uint8"], [2]), 2);
    state = await rules.applyMove(state, 0, encSetup(w.length, w.root));
    for (const ch of ["x", "z"]) {
      state = await rules.applyMove(state, 1, encGuess(LETTER(ch)));
      state = await rules.applyMove(state, 0, encDisc(w.discloseFor(LETTER(ch))));
    }
    // FINAL but only disclose positions 0 and 1 (omit position 2) ⇒ gap ⇒ fraud.
    const partial = w.discloseAll([]).filter((it) => it.position !== 2);
    state = await rules.applyMove(state, 0, encDisc(partial));
    expect(await rules.status(state)).to.equal(2n);
  });

  it("FRAUD: proving two different letters into the same position ⇒ guesser wins", async () => {
    const { rules } = await loadFixture(deploy);
    // Honest word is "cat". The committer first (honestly) reveals 'c' at position 0, then on a
    // later letter forges a proof putting another letter at position 0 too. We simulate the
    // contradiction by committing a SECOND leaf set whose 'a' sits at position 0.
    const w = commitWord("cat");
    let state = await rules.initialState(coder.encode(["uint8"], [6]), 2);
    state = await rules.applyMove(state, 0, encSetup(w.length, w.root));

    // Guess 'c' (honest): proves position 0.
    state = await rules.applyMove(state, 1, encGuess(LETTER("c")));
    state = await rules.applyMove(state, 0, encDisc(w.discloseFor(LETTER("c"))));
    expect(await rules.status(state)).to.equal(0n);

    // Guess 'a': the real 'a' is at position 1. A cheating committer instead claims 'a' at
    // position 0 (already filled by 'c'). To have a VALID proof for that lie they'd need a leaf
    // (0, 'a', salt) in the committed tree — impossible for "cat". So a genuine fraud requires a
    // committed collision; we build a word where the SAME position is provable for two letters by
    // committing both leaves into the tree.
    const collide = buildCollisionTree();
    let st2 = await rules.initialState(coder.encode(["uint8"], [6]), 2);
    st2 = await rules.applyMove(st2, 0, encSetup(3, collide.root));
    st2 = await rules.applyMove(st2, 1, encGuess(0)); // letter 'a'
    st2 = await rules.applyMove(st2, 0, encDisc(collide.discloseFor(0)));
    expect(await rules.status(st2)).to.equal(0n);
    st2 = await rules.applyMove(st2, 1, encGuess(1)); // letter 'b' — also committed at position 0
    st2 = await rules.applyMove(st2, 0, encDisc(collide.discloseFor(1)));
    expect(await rules.status(st2)).to.equal(2n); // contradiction ⇒ guesser wins
  });

  it("guessing the same letter twice reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const w = commitWord("cat");
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, encSetup(w.length, w.root));
    state = await rules.applyMove(state, 1, encGuess(LETTER("x")));
    state = await rules.applyMove(state, 0, encDisc([]));
    await expect(rules.applyMove(state, 1, encGuess(LETTER("x")))).to.be.revertedWithCustomError(
      rules,
      "AlreadyGuessed"
    );
  });

  it("wrong player for the phase reverts (guesser cannot run setup)", async () => {
    const { rules } = await loadFixture(deploy);
    const w = commitWord("cat");
    const state = await rules.initialState("0x", 2);
    await expect(rules.applyMove(state, 1, encSetup(w.length, w.root))).to.be.revertedWithCustomError(
      rules,
      "NotYourTurn"
    );
  });

  it("a disclosure with a bad proof reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const w = commitWord("cat");
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, encSetup(w.length, w.root));
    state = await rules.applyMove(state, 1, encGuess(LETTER("c")));
    // Tamper the proof: empty proof for a real leaf at position 0 of a 3-leaf tree.
    const bad = [{ position: 0, letter: LETTER("c"), salt: ethers.id("salt-cat-0"), proof: [] }];
    await expect(rules.applyMove(state, 0, encDisc(bad))).to.be.revertedWithCustomError(rules, "BadProof");
  });

  // Build a malicious tree that commits BOTH (pos0,'a') and (pos0,'b') so two letters can be
  // proven into the same cell — the cross-letter contradiction the rules must catch.
  function buildCollisionTree() {
    const s0 = ethers.id("c0a");
    const s1 = ethers.id("c0b");
    const s2 = ethers.id("c2");
    const lA = leafHash(0, 0, s0); // 'a' at position 0
    const lB = leafHash(0, 1, s1); // 'b' ALSO at position 0 (the fraud)
    const lC = leafHash(2, 2, s2); // 'c' at position 2
    const tree = buildTree([lA, lB, lC]);
    function discloseFor(letterCode) {
      if (letterCode === 0) return [{ position: 0, letter: 0, salt: s0, proof: tree.proof(0) }];
      if (letterCode === 1) return [{ position: 0, letter: 1, salt: s1, proof: tree.proof(1) }];
      return [];
    }
    return { root: tree.root, discloseFor };
  }
});
