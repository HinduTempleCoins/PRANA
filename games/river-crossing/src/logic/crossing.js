// Pure, side-effect-free River Crossing logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// The board is a stack of horizontal LANES, indexed from the START bank (bottom, highest
// row index) up to the FAR bank (top, row 0). The player occupies one cell { x, y } where
// y is the lane row and x is the column. A "step" moves the player one cell up/down/left/
// right; lane contents (vehicles, logs) drift continuously between steps and can carry or
// kill the player.
//
// Lane kinds:
//   'bank'   — safe grass strip (start bank at the bottom).
//   'road'   — vehicles slide across; sharing a cell with a vehicle is fatal.
//   'water'  — you must be standing ON a drifting log/reed; open water is fatal. While on a
//              log the river DRIFTS you sideways with it.
//   'goal'   — the far bank, carved into ALCOVES (a fixed set of fillable slots).

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const LANE = { BANK: 'bank', ROAD: 'road', WATER: 'water', GOAL: 'goal' };

// --- deterministic RNG ----------------------------------------------------------------- //
// A tiny seedable PRNG (mulberry32) so a given seed reproduces the exact same lane layout —
// every vehicle/log pattern is a pure function of the seed + difficulty tier.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// --- lane construction ----------------------------------------------------------------- //
// Build a full board layout for a difficulty `tier` (0-based). Higher tiers = faster /
// denser traffic and faster rivers. Deterministic in (seed, tier).
//
// Returns { cols, rows, lanes:[...], goalRow, startRow, alcoves:[cols...] }.
// lanes[y] describes lane at row y. Road/water lanes carry an `obstacles` array of
// { x, len } spans plus `dir` (+1 / -1) and `speed` (cells per second, fractional).
export function buildBoard(cols, rows, tier, seed) {
  const rng = makeRng((seed >>> 0) ^ (tier * 0x9e3779b1));
  const lanes = new Array(rows);

  const goalRow = 0; // far bank
  const startRow = rows - 1; // start bank

  // Difficulty scaling: traffic faster & denser, rivers faster with tier.
  const speedBoost = 1 + tier * 0.18;

  // Five alcove columns spread across the goal row.
  const alcoves = computeAlcoves(cols);

  for (let y = 0; y < rows; y++) {
    if (y === goalRow) {
      lanes[y] = { kind: LANE.GOAL, alcoves };
      continue;
    }
    if (y === startRow) {
      lanes[y] = { kind: LANE.BANK };
      continue;
    }
    // A middle "median" safe strip splits road band from water band.
    const median = Math.floor(rows / 2);
    if (y === median) {
      lanes[y] = { kind: LANE.BANK };
      continue;
    }

    const isWater = y < median; // upper half (toward goal) is the river
    const dir = rng() < 0.5 ? 1 : -1;
    const baseSpeed = (isWater ? 1.4 : 2.0) * speedBoost * (0.7 + rng() * 0.6);

    if (isWater) {
      // Logs: longer spans, sparser, so there is always a ridable path.
      const len = randInt(rng, 2, 4);
      const gap = randInt(rng, 2, 4);
      lanes[y] = {
        kind: LANE.WATER,
        dir,
        speed: round2(baseSpeed),
        obstacles: tile(cols, len, gap, rng),
      };
    } else {
      // Vehicles: short, with bigger gaps; vary length to vary "feel".
      const len = randInt(rng, 1, 2);
      const gap = randInt(rng, 2, 5);
      lanes[y] = {
        kind: LANE.ROAD,
        dir,
        speed: round2(baseSpeed),
        obstacles: tile(cols, len, gap, rng),
      };
    }
  }

  return { cols, rows, lanes, goalRow, startRow, alcoves };
}

// Five evenly-spread alcove columns on the goal row.
export function computeAlcoves(cols, count = 5) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // spread across interior so edges aren't alcoves
    const x = Math.round(((i + 1) / (count + 1)) * (cols - 1));
    out.push(x);
  }
  return out;
}

// Lay a repeating pattern of obstacle spans across `cols` starting at a random phase.
// Returns array of { x, len } with x in [0, cols).
function tile(cols, len, gap, rng) {
  const period = len + gap;
  const phase = randInt(rng, 0, period - 1);
  const out = [];
  for (let start = -period; start < cols + period; start += period) {
    const x = start + phase;
    if (x + len > 0 && x < cols) out.push({ x, len });
  }
  return out;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// --- continuous drift ------------------------------------------------------------------ //
// Lanes drift over time. We track a single scalar `offset` per lane (cells, fractional) that
// advances by dir*speed*dt each frame. Obstacle world position = baseX + dir*offset.
// We keep offset modulo the period implicitly via wrap helpers below.

// Advance a lane offset by dt seconds. Returns the new offset (unwrapped float; callers
// wrap when computing coverage). Pure.
export function advanceOffset(offset, lane, dtSeconds) {
  if (lane.kind !== LANE.ROAD && lane.kind !== LANE.WATER) return offset;
  return offset + lane.speed * dtSeconds;
}

// Compute the integer column an obstacle currently covers, given drift. Returns a Set of
// occupied columns wrapped into [0, cols). Used for collision (road) and ride-test (water).
export function occupiedColumns(lane, offset, cols) {
  const occ = new Set();
  if (!lane.obstacles) return occ;
  const shift = lane.dir * offset;
  for (const o of lane.obstacles) {
    for (let i = 0; i < o.len; i++) {
      const raw = Math.round(o.x + i + shift);
      occ.add(((raw % cols) + cols) % cols);
    }
  }
  return occ;
}

// --- stepping -------------------------------------------------------------------------- //
// Apply a directional step to a player position, clamped to the board. Returns the new
// { x, y }. Does NOT decide death/ride — that's evaluated against lane state separately.
export function stepPlayer(pos, dir, cols, rows) {
  const d = DIRS[dir];
  if (!d) return { ...pos };
  return {
    x: clamp(pos.x + d.x, 0, cols - 1),
    y: clamp(pos.y + d.y, 0, rows - 1),
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Carry the player sideways with the log they are riding. Given the lane's per-frame integer
// drift `cellsMoved` (signed), shift x by that, then test if they fell off the board edge
// (carried into the bank/void => drowned). Pure.
export function carry(pos, lane, cellsMoved, cols) {
  if (lane.kind !== LANE.WATER) return { pos: { ...pos }, sweptOff: false };
  const nx = pos.x + lane.dir * cellsMoved;
  if (nx < 0 || nx >= cols) {
    return { pos: { x: clamp(nx, 0, cols - 1), y: pos.y }, sweptOff: true };
  }
  return { pos: { x: nx, y: pos.y }, sweptOff: false };
}

// Evaluate the player's fate at their current cell given the live lane state.
// Returns { outcome, alcoveIndex }.
//   outcome ∈ 'safe' | 'dead' | 'riding' | 'goal'
//   - 'safe'   : on bank / median; nothing to do.
//   - 'dead'   : hit a vehicle (road) OR in open water (no log under foot) OR swept off.
//   - 'riding' : standing on a log in water — caller should carry them with the drift.
//   - 'goal'   : reached the goal row ON an empty alcove column (a fill).
// `occ` is occupiedColumns(lane, offset, cols) for the player's current lane.
export function evaluateCell(pos, lane, occ, filledAlcoves) {
  if (lane.kind === LANE.BANK) {
    return { outcome: 'safe' };
  }
  if (lane.kind === LANE.ROAD) {
    return { outcome: occ.has(pos.x) ? 'dead' : 'safe' };
  }
  if (lane.kind === LANE.WATER) {
    return { outcome: occ.has(pos.x) ? 'riding' : 'dead' };
  }
  if (lane.kind === LANE.GOAL) {
    const idx = lane.alcoves.indexOf(pos.x);
    if (idx === -1) return { outcome: 'dead' }; // hit the wall between alcoves
    if (filledAlcoves[idx]) return { outcome: 'dead' }; // alcove already taken
    return { outcome: 'goal', alcoveIndex: idx };
  }
  return { outcome: 'safe' };
}

// --- scoring --------------------------------------------------------------------------- //
// Score for advancing toward the goal (a net-new highest row reached).
export function forwardScore(prevBestRow, newRow, pointsPerRow) {
  // rows decrease toward the goal; reward only net progress.
  if (newRow >= prevBestRow) return 0;
  return (prevBestRow - newRow) * pointsPerRow;
}

// Bonus for filling an alcove; later alcoves in a sweep can be worth more (combo feel).
export function alcoveScore(filledCountBefore, base, perAlcoveBonus) {
  return base + filledCountBefore * perAlcoveBonus;
}

// Are all alcoves filled? (advance a difficulty tier + reset the field).
export function allAlcovesFilled(filledAlcoves) {
  return filledAlcoves.length > 0 && filledAlcoves.every(Boolean);
}

export function newAlcoveState(count = 5) {
  return new Array(count).fill(false);
}
