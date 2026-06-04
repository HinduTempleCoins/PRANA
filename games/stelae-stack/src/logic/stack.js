// Pure, side-effect-free Stelae Stack logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// A "stela" is a falling stone glyph (our original pieces — see PIECES below). The well is
// a 10-wide × 20-tall grid. Cells are 0 (empty) or a piece-key string (its colour).
//
// Coordinates: a piece is a list of {x,y} offset cells relative to the piece origin, plus an
// absolute board position {x,y}. Rotation is applied to the offset cells via rotation tables
// baked at load time (so the game and tests share the exact same geometry).

export const COLS = 10;
export const ROWS = 20;

// --- the stelae (ORIGINAL piece set) -------------------------------------------------- //
//
// TRADE-DRESS NOTE: this is DELIBERATELY NOT the classic 7-tetromino set. We ship FIVE
// pentomino-flavoured 5-cell glyphs plus TWO custom 3-cell "tri-stones". Different cell
// counts, different silhouettes, original names + palette. See README trade-dress note.
//
// Each piece: { key, name, color, cells:[{x,y}...] } where cells are the spawn orientation
// offsets. The bounding box is computed; rotations are generated about the box centre.
export const PIECES = {
  // --- pentomino-flavoured 5-cell glyphs --- //
  // "Obelisk" — tall I-like pillar but 5 cells (not the 4-cell tetromino I).
  OBELISK: { key: 'OBELISK', name: 'Obelisk', color: '#7fd6ff', cells: [
    { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }, { x: 0, y: 4 },
  ] },
  // "Ankh" — plus/cross pentomino.
  ANKH: { key: 'ANKH', name: 'Ankh', color: '#ffd27f', cells: [
    { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 },
  ] },
  // "Serpent" — S/Z-flavoured but a 5-cell W/zig (not the 4-cell S or Z).
  SERPENT: { key: 'SERPENT', name: 'Serpent', color: '#b07fff', cells: [
    { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ] },
  // "Lotus" — P-pentomino (a 2x2 block with a tail), original silhouette vs tetromino O/L.
  LOTUS: { key: 'LOTUS', name: 'Lotus', color: '#7fffb0', cells: [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 },
  ] },
  // "Falcon" — T-pentomino (a long bar with a centred stem).
  FALCON: { key: 'FALCON', name: 'Falcon', color: '#ff8f9f', cells: [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 },
  ] },
  // --- custom tri-stones (3-cell) --- //
  // "Cairn" — an L-shaped 3-stone corner.
  CAIRN: { key: 'CAIRN', name: 'Cairn', color: '#ffe27f', cells: [
    { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 },
  ] },
  // "Shard" — a straight 3-stone bar.
  SHARD: { key: 'SHARD', name: 'Shard', color: '#9fe0ff', cells: [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
  ] },
};

export const PIECE_KEYS = Object.keys(PIECES);

// --- rotation ------------------------------------------------------------------------- //
//
// Rotate offset cells 90° clockwise about the centre of their bounding box, then re-normalise
// so the min x/y is 0. Returns a NEW cell array (pure). We snap about the integer box span so
// rotations are stable and reproducible (the rotation tables a Tetris-like game uses).
export function boundingBox(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function normalizeCells(cells) {
  const { minX, minY } = boundingBox(cells);
  return cells.map((c) => ({ x: c.x - minX, y: c.y - minY }));
}

// One 90° clockwise rotation: (x,y) -> (maxY - y, x) within the box, then re-normalise.
export function rotateCW(cells) {
  const { maxY } = boundingBox(cells);
  const rotated = cells.map((c) => ({ x: maxY - c.y, y: c.x }));
  return normalizeCells(rotated);
}

// Precompute the 4 rotation states for a piece (some are equivalent; we keep 4 for a
// uniform, predictable rotation index). Returns an array of normalised cell arrays.
export function rotationStates(cells) {
  const states = [];
  let cur = normalizeCells(cells);
  for (let i = 0; i < 4; i++) {
    states.push(cur);
    cur = rotateCW(cur);
  }
  return states;
}

// Build the full rotation table for every piece, keyed by piece key.
export function buildRotationTable() {
  const table = {};
  for (const key of PIECE_KEYS) {
    table[key] = rotationStates(PIECES[key].cells);
  }
  return table;
}

export const ROTATIONS = buildRotationTable();

// Absolute occupied cells for a piece at board position {x,y} in rotation state `rot`.
export function pieceCells(pieceKey, rot, pos) {
  const states = ROTATIONS[pieceKey];
  const cells = states[((rot % 4) + 4) % 4];
  return cells.map((c) => ({ x: c.x + pos.x, y: c.y + pos.y }));
}

// --- well / collision ----------------------------------------------------------------- //

// Create an empty well: ROWS arrays of COLS zeros.
export function emptyWell(cols = COLS, rows = ROWS) {
  const grid = [];
  for (let y = 0; y < rows; y++) grid.push(new Array(cols).fill(0));
  return grid;
}

// Is a single cell inside the well bounds AND empty?
export function cellFree(well, x, y, cols = COLS, rows = ROWS) {
  if (x < 0 || x >= cols || y >= rows) return false; // walls + floor
  if (y < 0) return true; // above the ceiling is allowed (spawn buffer)
  return well[y][x] === 0;
}

// Can the piece occupy (pieceKey, rot, pos) without colliding walls/floor/stack?
export function isValid(well, pieceKey, rot, pos, cols = COLS, rows = ROWS) {
  for (const c of pieceCells(pieceKey, rot, pos)) {
    if (!cellFree(well, c.x, c.y, cols, rows)) return false;
  }
  return true;
}

// --- wall kicks (simplified) ---------------------------------------------------------- //
//
// On rotation, if the rotated piece collides, try a small set of horizontal nudges (and one
// up-nudge) so rotations near a wall/floor still "kick" into a legal spot — a simplified
// version of the SRS kick idea. Returns the new pos {x,y} and rot, or null if nothing fits.
export const KICK_OFFSETS = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: 0, y: -1 },
];

export function tryRotate(well, pieceKey, rot, pos, dir = 1, cols = COLS, rows = ROWS) {
  const nextRot = (((rot + dir) % 4) + 4) % 4;
  for (const k of KICK_OFFSETS) {
    const tryPos = { x: pos.x + k.x, y: pos.y + k.y };
    if (isValid(well, pieceKey, nextRot, tryPos, cols, rows)) {
      return { rot: nextRot, pos: tryPos };
    }
  }
  return null; // rotation blocked entirely
}

// --- movement ------------------------------------------------------------------------- //

// Try to move by (dx,dy). Returns the new pos if legal, else null.
export function tryMove(well, pieceKey, rot, pos, dx, dy, cols = COLS, rows = ROWS) {
  const next = { x: pos.x + dx, y: pos.y + dy };
  return isValid(well, pieceKey, rot, next, cols, rows) ? next : null;
}

// Hard-drop: return the lowest legal pos (drop straight down until the next step collides),
// and the number of cells dropped.
export function hardDropPos(well, pieceKey, rot, pos, cols = COLS, rows = ROWS) {
  let cur = pos;
  let dropped = 0;
  for (;;) {
    const next = { x: cur.x, y: cur.y + 1 };
    if (!isValid(well, pieceKey, rot, next, cols, rows)) break;
    cur = next;
    dropped += 1;
  }
  return { pos: cur, dropped };
}

// --- lock + line clear ---------------------------------------------------------------- //

// Lock the piece into the well (mutates a COPY, returns it) by stamping its colour key.
export function lockPiece(well, pieceKey, rot, pos) {
  const next = well.map((row) => row.slice());
  const color = PIECES[pieceKey].key; // store the key; renderer maps key->color
  for (const c of pieceCells(pieceKey, rot, pos)) {
    if (c.y >= 0 && c.y < next.length && c.x >= 0 && c.x < next[0].length) {
      next[c.y][c.x] = color;
    }
  }
  return next;
}

// Clear all full rows. Returns { well, cleared } — a NEW well with full rows removed and
// empty rows prepended at the top, and the count of rows cleared.
export function clearLines(well, cols = COLS) {
  const kept = well.filter((row) => row.some((cell) => cell === 0));
  const cleared = well.length - kept.length;
  const out = [];
  for (let i = 0; i < cleared; i++) out.push(new Array(cols).fill(0));
  return { well: out.concat(kept), cleared };
}

// --- scoring -------------------------------------------------------------------------- //
//
// Classic line bonus scaled by level, PLUS a combo multiplier for consecutive clearing
// drops (each drop that clears >=1 line increments the combo; a non-clearing drop resets it).
export const LINE_BASE = { 0: 0, 1: 100, 2: 300, 3: 500, 4: 800 };

// Points for clearing `lines` rows at `level` with the given `combo` count (combo>=0).
// combo 0 => x1, combo 1 => x1.5, combo 2 => x2, ... (1 + combo*0.5), rounded.
export function lineScore(lines, level, combo = 0) {
  const base = LINE_BASE[lines] ?? (lines > 4 ? 1000 + (lines - 4) * 300 : 0);
  const levelMul = level + 1; // level is 0-indexed internally
  const comboMul = 1 + Math.max(0, combo) * 0.5;
  return Math.round(base * levelMul * comboMul);
}

// Soft-drop / hard-drop reward: small points per cell dropped (encourages decisive play).
export function dropScore(cells, hard = false) {
  return Math.max(0, cells) * (hard ? 2 : 1);
}

// Advance the combo counter for a drop. A drop that clears >=1 line increments combo;
// a drop that clears 0 lines resets it to -1 (so the next clear starts at combo 0).
export function nextCombo(combo, linesCleared) {
  return linesCleared > 0 ? combo + 1 : -1;
}

// --- level / gravity ------------------------------------------------------------------ //

// Level rises every `per` cleared lines (gentle ramp). level is 0-indexed.
export function levelForLines(totalLines, per = 10) {
  return Math.floor(totalLines / per);
}

// Gravity step interval (ms) for a level: starts slow, ramps down gently, clamps to a floor.
export function gravityInterval(level, base = 800, perLevel = 60, floor = 100) {
  return Math.max(floor, base - level * perLevel);
}

// --- spawn / top-out ------------------------------------------------------------------ //

// Spawn position for a piece: horizontally centred, just above/at the top.
export function spawnPos(pieceKey, cols = COLS) {
  const states = ROTATIONS[pieceKey];
  const { w } = boundingBox(states[0]);
  return { x: Math.floor((cols - w) / 2), y: 0 };
}

// Pick the next piece key from an rng in [0,1). Deterministic given the rng.
export function randomPiece(rng = Math.random) {
  return PIECE_KEYS[Math.floor(rng() * PIECE_KEYS.length)];
}

// Top-out test: a freshly-spawned piece that is already invalid at its spawn => game over.
export function isToppedOut(well, pieceKey, cols = COLS, rows = ROWS) {
  const pos = spawnPos(pieceKey, cols);
  return !isValid(well, pieceKey, 0, pos, cols, rows);
}
