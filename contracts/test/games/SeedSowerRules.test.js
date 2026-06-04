const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ----------------------------------------------------------------------------
// JS helpers mirroring the on-chain encoding (see SeedSowerRules.sol header).
//   board: uint8[14]  slots 0..5 = P1 pits, 6 = P1 store, 7..12 = P2 pits, 13 = P2 store
//   state = abi.encode(uint8[14] board, uint8 toMove, bool over)
//   move  = abi.encode(uint8[] pits)   (local pit indices 0..5)
// ----------------------------------------------------------------------------
const coder = ethers.AbiCoder.defaultAbiCoder();
const P1_STORE = 6;
const P2_STORE = 13;

const encodeState = (board, toMove, over) =>
  coder.encode(["uint8[14]", "uint8", "bool"], [board, toMove, over]);

function decodeState(bytes) {
  const [board, toMove, over] = coder.decode(["uint8[14]", "uint8", "bool"], bytes);
  return { board: board.map(Number), toMove: Number(toMove), over };
}

const encodeMove = (pits) => coder.encode(["uint8[]"], [pits]);

function freshBoard() {
  const b = new Array(14).fill(4);
  b[P1_STORE] = 0;
  b[P2_STORE] = 0;
  return b;
}

describe("SeedSowerRules", function () {
  async function deployFixture() {
    const Rules = await ethers.getContractFactory("SeedSowerRules");
    const rules = await Rules.deploy();
    return { rules };
  }

  describe("initialState", function () {
    it("seeds 4 per pit, empty stores, P1 to move", async function () {
      const { rules } = await loadFixture(deployFixture);
      const s = decodeState(await rules.initialState("0x", 2));
      expect(s.board).to.deep.equal(freshBoard());
      expect(s.toMove).to.equal(1);
      expect(s.over).to.equal(false);
    });

    it("reverts on non-2-player tables", async function () {
      const { rules } = await loadFixture(deployFixture);
      await expect(rules.initialState("0x", 3)).to.be.revertedWithCustomError(
        rules,
        "BadPlayerCount"
      );
    });
  });

  describe("sowing math", function () {
    it("sows counter-clockwise from a pit, ending in a normal pit (turn passes)", async function () {
      const { rules } = await loadFixture(deployFixture);
      // P1 sows pit 1 (slot 1, 4 seeds) -> slots 2,3,4,5 each +1. Ends at slot 5 (own pit,
      // was non-empty before so no capture, not the store).
      const out = await rules.applyMove(encodeState(freshBoard(), 1, false), 0, encodeMove([1]));
      const s = decodeState(out);
      expect(s.board[1]).to.equal(0);
      expect(s.board[2]).to.equal(5);
      expect(s.board[5]).to.equal(5);
      expect(s.board[P1_STORE]).to.equal(0); // didn't reach store
      expect(s.toMove).to.equal(2); // turn passed
    });

    it("landing the last seed in own store earns an extra turn", async function () {
      const { rules } = await loadFixture(deployFixture);
      // P1 pit 2 (slot 2, 4 seeds) -> slots 3,4,5,6(store). Last lands in store => extra turn.
      // Single-element move would have to continue, so it must MustContinue-revert.
      await expect(
        rules.applyMove(encodeState(freshBoard(), 1, false), 0, encodeMove([2]))
      ).to.be.revertedWithCustomError(rules, "MustContinue");
    });

    it("wraps around the board skipping the OPPONENT's store", async function () {
      const { rules } = await loadFixture(deployFixture);
      // Give P1 pit 5 (slot 5) a big pile so sowing wraps past P2's pits + store back to P1.
      const b = freshBoard();
      b[5] = 9; // sow slots 6,7,8,9,10,11,12,(skip 13=P2 store),0  -> 9 placements
      const out = await rules.applyMove(encodeState(b, 1, false), 0, encodeMove([5]));
      const s = decodeState(out);
      expect(s.board[5]).to.equal(0);
      expect(s.board[P1_STORE]).to.equal(1); // slot 6 got a seed
      expect(s.board[12]).to.equal(5); // P2's last pit +1
      expect(s.board[P2_STORE]).to.equal(0); // opponent store skipped
      expect(s.board[0]).to.equal(5); // wrapped onto P1 pit 0
      expect(s.toMove).to.equal(2);
    });

    it("P2 sowing skips P1's store", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = freshBoard();
      b[12] = 9; // P2 pit 5 -> 13(store),0..5,(skip 6=P1 store),7  = 9 placements
      const out = await rules.applyMove(encodeState(b, 2, false), 1, encodeMove([5]));
      const s = decodeState(out);
      expect(s.board[12]).to.equal(0);
      expect(s.board[P2_STORE]).to.equal(1); // its own store seeded
      expect(s.board[P1_STORE]).to.equal(0); // P1 store skipped
      expect(s.board[7]).to.equal(5); // wrapped onto P2 pit 0
    });
  });

  describe("capture", function () {
    it("last seed into an own EMPTY pit captures it + the opposite pit", async function () {
      const { rules } = await loadFixture(deployFixture);
      // Craft: P1 pit 0 holds 1 seed, pit 1 empty, opposite of slot 1 is slot 11 (=12-1).
      const b = freshBoard();
      b[0] = 1; // sow exactly one seed -> lands in slot 1
      b[1] = 0; // slot 1 empty before
      b[11] = 7; // opposite pit loaded
      const out = await rules.applyMove(encodeState(b, 1, false), 0, encodeMove([0]));
      const s = decodeState(out);
      expect(s.board[1]).to.equal(0); // captured (landed seed removed)
      expect(s.board[11]).to.equal(0); // opposite swept
      expect(s.board[P1_STORE]).to.equal(8); // 1 + 7
      expect(s.toMove).to.equal(2);
    });

    it("no capture when opposite pit is empty", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = freshBoard();
      b[0] = 1;
      b[1] = 0;
      b[11] = 0; // opposite empty -> no capture
      const out = await rules.applyMove(encodeState(b, 1, false), 0, encodeMove([0]));
      const s = decodeState(out);
      expect(s.board[1]).to.equal(1); // seed stays
      expect(s.board[P1_STORE]).to.equal(0);
    });
  });

  describe("extra-turn streak validation", function () {
    it("a valid streak chains store-landings then ends by passing the turn", async function () {
      const { rules } = await loadFixture(deployFixture);
      // Build a board where pit 5 (slot 5, 1 seed) lands in P1 store (extra turn), then
      // pit 0 (slot 0) sows normally and ends off-store passing the turn.
      const b = freshBoard();
      b[5] = 1; // -> slot 6 (store): extra turn
      b[0] = 1; // -> slot 1: normal, ends turn
      const out = await rules.applyMove(encodeState(b, 1, false), 0, encodeMove([5, 0]));
      const s = decodeState(out);
      expect(s.board[P1_STORE]).to.equal(1);
      expect(s.board[1]).to.equal(5); // 4 + sown seed
      expect(s.toMove).to.equal(2);
    });

    it("illegal continuation (previous sow did NOT earn extra turn) reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      // pit 0 sows to a normal pit (no extra turn); a second element is illegal.
      const b = freshBoard();
      b[0] = 1; // ends slot 1, not store
      await expect(
        rules.applyMove(encodeState(b, 1, false), 0, encodeMove([0, 1]))
      ).to.be.revertedWithCustomError(rules, "NoExtraTurn");
    });

    it("empty move reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      await expect(
        rules.applyMove(encodeState(freshBoard(), 1, false), 0, encodeMove([]))
      ).to.be.revertedWithCustomError(rules, "EmptyMove");
    });

    it("sowing an empty pit reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = freshBoard();
      b[3] = 0;
      await expect(
        rules.applyMove(encodeState(b, 1, false), 0, encodeMove([3]))
      ).to.be.revertedWithCustomError(rules, "PitEmpty");
    });

    it("pit index out of range reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      await expect(
        rules.applyMove(encodeState(freshBoard(), 1, false), 0, encodeMove([6]))
      ).to.be.revertedWithCustomError(rules, "PitOutOfRange");
    });

    it("wrong player to move reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      await expect(
        rules.applyMove(encodeState(freshBoard(), 1, false), 1, encodeMove([0]))
      ).to.be.revertedWithCustomError(rules, "BadPlayer");
    });
  });

  describe("endgame sweep + win/tie", function () {
    it("emptying a side ends the game and banks the opponent's remaining seeds", async function () {
      const { rules } = await loadFixture(deployFixture);
      // P1 has a single seed in pit 5; sowing it lands in P1's own store (its last seed),
      // which empties every P1 pit -> terminal -> the sweep banks P2's remaining pit seeds
      // into P2's store. (Landing in the store would normally grant an extra turn, but a
      // terminal board ends the move instead of requiring a continuation.)
      const b = new Array(14).fill(0);
      b[5] = 1; // slot 5 -> P1 store (slot 6), then P1 side is empty -> terminal
      b[7] = 3; // P2 pit seeds to be swept
      b[8] = 2;
      b[P1_STORE] = 6;
      b[P2_STORE] = 1;
      const out = await rules.applyMove(encodeState(b, 1, false), 0, encodeMove([5]));
      const s = decodeState(out);
      expect(s.over).to.equal(true);
      for (let i = 0; i < 6; i++) expect(s.board[i]).to.equal(0);
      for (let i = 7; i < 13; i++) expect(s.board[i]).to.equal(0);
      // P1 store: 6 + the seed sown into it = 7.
      expect(s.board[P1_STORE]).to.equal(7);
      // P2 store: 1 + swept (3+2) = 6.
      expect(s.board[P2_STORE]).to.equal(6);
    });

    it("status: higher store wins, draw on tie, ongoing otherwise", async function () {
      const { rules } = await loadFixture(deployFixture);
      const win1 = freshBoard();
      win1[P1_STORE] = 30;
      win1[P2_STORE] = 18;
      expect(await rules.status(encodeState(win1, 1, true))).to.equal(1);

      const win2 = freshBoard();
      win2[P1_STORE] = 10;
      win2[P2_STORE] = 38;
      expect(await rules.status(encodeState(win2, 1, true))).to.equal(2);

      const tie = freshBoard();
      tie[P1_STORE] = 24;
      tie[P2_STORE] = 24;
      expect(await rules.status(encodeState(tie, 1, true))).to.equal(255);

      // not over yet
      expect(await rules.status(encodeState(freshBoard(), 1, false))).to.equal(0);
    });

    it("applying a move after game over reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      await expect(
        rules.applyMove(encodeState(freshBoard(), 1, true), 0, encodeMove([0]))
      ).to.be.revertedWithCustomError(rules, "GameOver");
    });
  });

  describe("metadata", function () {
    it("reports name and player bounds", async function () {
      const { rules } = await loadFixture(deployFixture);
      expect(await rules.gameName()).to.equal("SeedSower");
      expect(await rules.minPlayers()).to.equal(2);
      expect(await rules.maxPlayers()).to.equal(2);
      expect(await rules.simultaneous("0x")).to.equal(false);
    });
  });
});
