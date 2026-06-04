// Pure, side-effect-free Mergestone logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// The board is a flat array of length size*size, row-major (index = y*size + x).
// A cell holds a TIER (1, 2, 3, …) or 0 for empty. The *value* of a tier is 2^tier
// (tier 1 = 2, tier 2 = 4, …) — classic 2048 numbers, but the game speaks in tiers so the
// carved-rune glyphs map cleanly to tier ids.

export const SIZE = 4;

// Value shown on a stone of the given tier (tier 1 => 2, tier 2 => 4, …).
export function tierValue(tier) {
  return tier <= 0 ? 0 : 2 ** tier;
}

// --- seeded PRNG (mulberry32) --------------------------------------------------------- //
// Deterministic so spawns are reproducible in tests and across a replayed run.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- board helpers -------------------------------------------------------------------- //

export function emptyBoard(size = SIZE) {
  return new Array(size * size).fill(0);
}

export function idx(x, y, size = SIZE) {
  return y * size + x;
}

// Extract one line (row or column) as a length-`size` array of tiers.
// dir picks the traversal order so a single compress+merge handles all four directions:
//   'left'  -> rows read left→right
//   'right' -> rows read right→left
//   'up'    -> cols read top→bottom
//   'down'  -> cols read bottom→top
// We always compress toward index 0 of the returned line, then write it back reversed if
// the direction is right/down.
function getLine(board, i, dir, size) {
  const line = new Array(size);
  for (let j = 0; j < size; j++) {
    let x;
    let y;
    if (dir === 'left' || dir === 'right') {
      y = i;
      x = dir === 'left' ? j : size - 1 - j;
    } else {
      x = i;
      y = dir === 'up' ? j : size - 1 - j;
    }
    line[j] = board[idx(x, y, size)];
  }
  return line;
}

function setLine(board, i, dir, line, size) {
  for (let j = 0; j < size; j++) {
    let x;
    let y;
    if (dir === 'left' || dir === 'right') {
      y = i;
      x = dir === 'left' ? j : size - 1 - j;
    } else {
      x = i;
      y = dir === 'up' ? j : size - 1 - j;
    }
    board[idx(x, y, size)] = line[j];
  }
}

// Slide+merge a single line toward index 0. PURE on the input array.
// Returns { line, gained, merges } where:
//   line   : the resulting length-`size` array (padded with 0s at the far end)
//   gained : score gained (sum of the VALUES of the newly-formed stones)
//   merges : list of { tier } for the new (merged) stones — for tween/animation hooks
//
// THE ONCE-PER-MOVE RULE: a stone that was itself the product of a merge this move cannot
// merge again in the same move. Classic case: [2,2,2,2] -> [4,4] (NOT [8]); [4,2,2] ->
// [4,4] (the two 2s merge; the leading 4 is untouched). We enforce it by walking the
// compacted (non-zero) values once and skipping the next item after a merge.
export function slideLine(rawLine, size = SIZE) {
  const compact = rawLine.filter((t) => t !== 0);
  const out = [];
  const merges = [];
  let gained = 0;
  let k = 0;
  while (k < compact.length) {
    if (k + 1 < compact.length && compact[k] === compact[k + 1]) {
      const newTier = compact[k] + 1;
      out.push(newTier);
      gained += tierValue(newTier);
      merges.push({ tier: newTier });
      k += 2; // consume both — the merged stone is locked for the rest of this move
    } else {
      out.push(compact[k]);
      k += 1;
    }
  }
  while (out.length < size) out.push(0);
  return { line: out, gained, merges };
}

// Apply a move in `dir` to the whole board. PURE: returns a NEW board.
// Returns { board, moved, gained, merges } where `moved` is true iff the board changed.
export function move(board, dir, size = SIZE) {
  const next = board.slice();
  let gained = 0;
  let moved = false;
  const merges = [];
  for (let i = 0; i < size; i++) {
    const line = getLine(board, i, dir, size);
    const res = slideLine(line, size);
    // detect change against the ORIGINAL orientation line
    for (let j = 0; j < size; j++) {
      if (res.line[j] !== line[j]) {
        moved = true;
        break;
      }
    }
    setLine(next, i, dir, res.line, size);
    gained += res.gained;
    for (const m of res.merges) merges.push(m);
  }
  return { board: next, moved, gained, merges };
}

// --- spawning ------------------------------------------------------------------------- //

// List of empty cell indices.
export function emptyCells(board) {
  const cells = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) cells.push(i);
  }
  return cells;
}

// Spawn a new stone into a random empty cell using the seeded rng.
// 90% tier 1 (value 2), 10% tier 2 (value 4). Returns { board, cell, tier } or null if the
// board is full (no empty cell). PURE: returns a NEW board.
export function spawn(board, rng = Math.random) {
  const empties = emptyCells(board);
  if (empties.length === 0) return null;
  const cell = empties[Math.floor(rng() * empties.length)];
  const tier = rng() < 0.1 ? 2 : 1;
  const next = board.slice();
  next[cell] = tier;
  return { board: next, cell, tier };
}

// --- game-over check ------------------------------------------------------------------ //

// Does ANY of the four moves change the board? If none do, the game is over.
export function canMove(board, size = SIZE) {
  if (emptyCells(board).length > 0) return true; // an empty cell means a slide is possible
  for (const dir of ['left', 'right', 'up', 'down']) {
    if (move(board, dir, size).moved) return true;
  }
  return false;
}

export function isGameOver(board, size = SIZE) {
  return !canMove(board, size);
}

// --- new game ------------------------------------------------------------------------- //

// Build a fresh board with two starting stones, using the seeded rng. PURE.
export function newGame(rng = Math.random, size = SIZE) {
  let board = emptyBoard(size);
  for (let n = 0; n < 2; n++) {
    const res = spawn(board, rng);
    if (res) board = res.board;
  }
  return board;
}

// Highest tier currently on the board (0 if empty) — used for the "best stone" HUD.
export function maxTier(board) {
  let m = 0;
  for (const t of board) if (t > m) m = t;
  return m;
}
