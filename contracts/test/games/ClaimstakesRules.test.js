const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ----------------------------------------------------------------------------
// JS helpers mirroring the on-chain encoding (see ClaimstakesRules.sol header).
//   config = abi.encode(uint8 cols, uint8 rows)   (box dims; empty => 4x4 default)
//   state  = abi.encode(uint8 cols, uint8 rows, bool[] edges, uint8[] boxes,
//                        uint8 toMove, uint16 claimed)
//   move   = abi.encode(uint256[] edges)   (the streak of edge indices)
//
// Edge indexing: HORIZONTAL first, row-major, then VERTICAL.
//   H = (rows+1)*cols horizontal edges.  hEdge(hr,hc) = hr*cols + hc.
//   V = rows*(cols+1) vertical edges.    vEdge(vr,vc) = H + vr*(cols+1) + vc.
//   Box (br,bc) edges: top=hEdge(br,bc), bottom=hEdge(br+1,bc),
//                      left=vEdge(br,bc), right=vEdge(br,bc+1).
// ----------------------------------------------------------------------------
const coder = ethers.AbiCoder.defaultAbiCoder();

const STATE_T = ["uint8", "uint8", "bool[]", "uint8[]", "uint8", "uint16"];

const encodeConfig = (cols, rows) => coder.encode(["uint8", "uint8"], [cols, rows]);
const encodeMove = (edges) => coder.encode(["uint256[]"], [edges]);

function decodeState(bytes) {
  const [cols, rows, edges, boxes, toMove, claimed] = coder.decode(STATE_T, bytes);
  return {
    cols: Number(cols),
    rows: Number(rows),
    edges,
    boxes: boxes.map(Number),
    toMove: Number(toMove),
    claimed: Number(claimed),
  };
}

// Board helper: build a state from scratch for crafted scenarios.
function makeBoard(cols, rows) {
  const H = (rows + 1) * cols;
  const V = rows * (cols + 1);
  return {
    cols,
    rows,
    H,
    edges: new Array(H + V).fill(false),
    boxes: new Array(cols * rows).fill(0),
    toMove: 1,
    claimed: 0,
    hEdge(hr, hc) {
      return hr * cols + hc;
    },
    vEdge(vr, vc) {
      return this.H + vr * (cols + 1) + vc;
    },
    encode() {
      return coder.encode(STATE_T, [
        this.cols,
        this.rows,
        this.edges,
        this.boxes,
        this.toMove,
        this.claimed,
      ]);
    },
  };
}

describe("ClaimstakesRules", function () {
  async function deployFixture() {
    const Rules = await ethers.getContractFactory("ClaimstakesRules");
    const rules = await Rules.deploy();
    return { rules };
  }

  describe("initialState", function () {
    it("defaults to 4x4 boxes (5x5 dots), 40 edges, P1 to move", async function () {
      const { rules } = await loadFixture(deployFixture);
      const s = decodeState(await rules.initialState("0x", 2));
      expect(s.cols).to.equal(4);
      expect(s.rows).to.equal(4);
      // H = 5*4 = 20, V = 4*5 = 20 => 40 edges; 16 boxes.
      expect(s.edges.length).to.equal(40);
      expect(s.boxes.length).to.equal(16);
      expect(s.toMove).to.equal(1);
      expect(s.claimed).to.equal(0);
    });

    it("honors a config-sized grid", async function () {
      const { rules } = await loadFixture(deployFixture);
      const s = decodeState(await rules.initialState(encodeConfig(3, 3), 2));
      // H = 4*3 = 12, V = 3*4 = 12 => 24 edges; 9 boxes.
      expect(s.edges.length).to.equal(24);
      expect(s.boxes.length).to.equal(9);
    });

    it("reverts non-2-player and out-of-cap configs", async function () {
      const { rules } = await loadFixture(deployFixture);
      await expect(rules.initialState("0x", 3)).to.be.revertedWithCustomError(
        rules,
        "BadPlayerCount"
      );
      await expect(
        rules.initialState(encodeConfig(9, 3), 2)
      ).to.be.revertedWithCustomError(rules, "BadConfig");
      await expect(
        rules.initialState(encodeConfig(0, 3), 2)
      ).to.be.revertedWithCustomError(rules, "BadConfig");
    });
  });

  describe("edge claims + scoring", function () {
    it("a non-completing edge ends the move (turn passes)", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      // Draw one lone edge: claims nothing, passes the turn.
      const out = await rules.applyMove(b.encode(), 0, encodeMove([b.hEdge(0, 0)]));
      const s = decodeState(out);
      expect(s.edges[b.hEdge(0, 0)]).to.equal(true);
      expect(s.claimed).to.equal(0);
      expect(s.toMove).to.equal(2);
    });

    it("completing a box scores it for the mover and grants continuation", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      // Pre-draw 3 of box(0,0)'s edges; the 4th completes it. After completing, the streak
      // MUST continue, so include a second (non-completing) edge to legally end the turn.
      b.edges[b.hEdge(0, 0)] = true; // top
      b.edges[b.hEdge(1, 0)] = true; // bottom
      b.edges[b.vEdge(0, 0)] = true; // left
      const closing = b.vEdge(0, 1); // right -> completes box(0,0)
      const filler = b.hEdge(4, 3); // far-away lone edge, completes nothing
      const out = await rules.applyMove(b.encode(), 0, encodeMove([closing, filler]));
      const s = decodeState(out);
      expect(s.boxes[0]).to.equal(1); // box(0,0) -> player 1
      expect(s.claimed).to.equal(1);
      expect(s.toMove).to.equal(2); // turn passed after the non-scoring filler
    });

    it("a single edge that completes a box must continue (MustContinue)", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      b.edges[b.hEdge(0, 0)] = true;
      b.edges[b.hEdge(1, 0)] = true;
      b.edges[b.vEdge(0, 0)] = true;
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([b.vEdge(0, 1)]))
      ).to.be.revertedWithCustomError(rules, "MustContinue");
    });

    it("one edge can complete TWO boxes at once (counts 2)", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      // The shared edge between box(0,0) and box(1,0) is hEdge(1,0). Surround both so this
      // horizontal completes both simultaneously.
      // box(0,0): top hEdge(0,0), left vEdge(0,0), right vEdge(0,1)
      // box(1,0): bottom hEdge(2,0), left vEdge(1,0), right vEdge(1,1)
      for (const e of [
        b.hEdge(0, 0),
        b.vEdge(0, 0),
        b.vEdge(0, 1),
        b.hEdge(2, 0),
        b.vEdge(1, 0),
        b.vEdge(1, 1),
      ]) {
        b.edges[e] = true;
      }
      const shared = b.hEdge(1, 0);
      const filler = b.hEdge(4, 3);
      const out = await rules.applyMove(b.encode(), 0, encodeMove([shared, filler]));
      const s = decodeState(out);
      expect(s.boxes[0]).to.equal(1); // box(0,0)
      expect(s.boxes[4]).to.equal(1); // box(1,0) -> index 1*cols+0 = 4
      expect(s.claimed).to.equal(2);
    });
  });

  describe("streak chaining", function () {
    it("chains multiple box completions across the streak", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      // box(0,0): top/bottom/left pre-drawn; vEdge(0,1) (its right) will close it.
      b.edges[b.hEdge(0, 0)] = true;
      b.edges[b.hEdge(1, 0)] = true;
      b.edges[b.vEdge(0, 0)] = true;
      // box(0,1): top/bottom pre-drawn; its left is the shared vEdge(0,1), its right vEdge(0,2)
      // is drawn AS the second streak edge -> box(0,1) closes only after edgeA + edgeB.
      b.edges[b.hEdge(0, 1)] = true;
      b.edges[b.hEdge(1, 1)] = true;
      const edgeA = b.vEdge(0, 1); // completes box(0,0) only (box(0,1) still missing its right)
      const edgeB = b.vEdge(0, 2); // completes box(0,1)
      const filler = b.hEdge(4, 3);
      const out = await rules.applyMove(b.encode(), 0, encodeMove([edgeA, edgeB, filler]));
      const s = decodeState(out);
      expect(s.boxes[0]).to.equal(1); // box(0,0)
      expect(s.boxes[1]).to.equal(1); // box(0,1) -> index 0*4+1 = 1
      expect(s.claimed).to.equal(2);
      expect(s.toMove).to.equal(2);
    });

    it("continuation after a non-scoring edge reverts (NoExtraTurn)", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      // First edge scores nothing; a second element is then illegal.
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([b.hEdge(0, 0), b.hEdge(2, 2)]))
      ).to.be.revertedWithCustomError(rules, "NoExtraTurn");
    });
  });

  describe("invalid moves", function () {
    it("double-claimed (already drawn) edge reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      b.edges[b.hEdge(0, 0)] = true;
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([b.hEdge(0, 0)]))
      ).to.be.revertedWithCustomError(rules, "EdgeTaken");
    });

    it("repeating an edge within the same streak reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      // Set up box(0,0) so edgeA completes it (continuation), then re-submitting edgeA fails.
      b.edges[b.hEdge(0, 0)] = true;
      b.edges[b.hEdge(1, 0)] = true;
      b.edges[b.vEdge(0, 0)] = true;
      const edgeA = b.vEdge(0, 1);
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([edgeA, edgeA]))
      ).to.be.revertedWithCustomError(rules, "EdgeTaken");
    });

    it("edge index out of range reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([999]))
      ).to.be.revertedWithCustomError(rules, "EdgeOutOfRange");
    });

    it("empty move reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([]))
      ).to.be.revertedWithCustomError(rules, "EmptyMove");
    });

    it("wrong player to move reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(4, 4);
      await expect(
        rules.applyMove(b.encode(), 1, encodeMove([b.hEdge(0, 0)]))
      ).to.be.revertedWithCustomError(rules, "BadPlayer");
    });
  });

  describe("full game terminal — win and draw paths", function () {
    // Play a whole 1x2 board (2 boxes) deterministically to reach a terminal state.
    // 1x2 (cols=2, rows=1): H = 2*2 = 4 horizontals, V = 1*3 = 3 verticals => 7 edges.
    //   boxes: box(0,0) index 0, box(0,1) index 1.
    it("decisive: one player sweeps both boxes (2-0 win)", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(2, 1);
      // Draw every edge except the shared middle vEdge(0,1). Drawing that one edge completes
      // BOTH boxes at once -> the move is the final, terminal edge (no continuation needed).
      for (let e = 0; e < b.edges.length; e++) b.edges[e] = true;
      b.edges[b.vEdge(0, 1)] = false;
      const out = await rules.applyMove(b.encode(), 0, encodeMove([b.vEdge(0, 1)]));
      const s = decodeState(out);
      expect(s.claimed).to.equal(2);
      expect(s.boxes[0]).to.equal(1);
      expect(s.boxes[1]).to.equal(1);
      // Terminal: status reports player 1 the winner.
      expect(await rules.status(out)).to.equal(1);
    });

    it("draw: even split on a 2-box board (1-1)", async function () {
      const { rules } = await loadFixture(deployFixture);
      // Build a terminal state directly: both boxes drawn, one each.
      const b = makeBoard(2, 1);
      for (let e = 0; e < b.edges.length; e++) b.edges[e] = true;
      b.boxes[0] = 1;
      b.boxes[1] = 2;
      b.claimed = 2;
      expect(await rules.status(b.encode())).to.equal(255);
    });

    it("odd-box config cannot draw (decided by majority)", async function () {
      const { rules } = await loadFixture(deployFixture);
      // 3x3 = 9 boxes terminal, P1 has 5, P2 has 4.
      const b = makeBoard(3, 3);
      for (let e = 0; e < b.edges.length; e++) b.edges[e] = true;
      for (let i = 0; i < 9; i++) b.boxes[i] = i < 5 ? 1 : 2;
      b.claimed = 9;
      expect(await rules.status(b.encode())).to.equal(1);
    });

    it("status is ongoing before all boxes claimed", async function () {
      const { rules } = await loadFixture(deployFixture);
      const s = await (await ethers.getContractFactory("ClaimstakesRules"))
        .deploy()
        .then((r) => r.initialState("0x", 2));
      expect(await rules.status(s)).to.equal(0);
    });

    it("applying a move after terminal reverts", async function () {
      const { rules } = await loadFixture(deployFixture);
      const b = makeBoard(2, 1);
      for (let e = 0; e < b.edges.length; e++) b.edges[e] = true;
      b.boxes[0] = 1;
      b.boxes[1] = 1;
      b.claimed = 2;
      await expect(
        rules.applyMove(b.encode(), 0, encodeMove([0]))
      ).to.be.revertedWithCustomError(rules, "GameOver");
    });
  });

  describe("metadata", function () {
    it("reports name and player bounds", async function () {
      const { rules } = await loadFixture(deployFixture);
      expect(await rules.gameName()).to.equal("Claimstakes");
      expect(await rules.minPlayers()).to.equal(2);
      expect(await rules.maxPlayers()).to.equal(2);
      expect(await rules.simultaneous("0x")).to.equal(false);
    });
  });
});
