// Pure, side-effect-free Sky Sentinels logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// The formation is a grid of sentinels addressed by (col, row). It marches sideways in
// discrete STEPS; when any live sentinel would cross a side margin, the whole formation
// reverses direction and drops down by one row's worth of pixels. Step cadence accelerates
// as ranks thin and as waves advance.

// --- formation construction ----------------------------------------------------------- //

// Build a fresh formation for a wave. Returns:
//   { sentinels:[{col,row,alive}], offsetX, offsetY, dir }
//   dir = +1 (marching right) or -1 (marching left). offsetX/Y is the formation's pixel
//   translation from the wave-start anchor; per-sentinel pixel pos is derived in cellPos().
export function makeFormation(grid) {
  const sentinels = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      sentinels.push({ col, row, alive: true });
    }
  }
  return { sentinels, offsetX: 0, offsetY: 0, dir: 1 };
}

// Pixel center of a sentinel at (col,row), given the formation offset and grid metrics.
// The anchor places col 0 at sideMargin + cellW/2 and row 0 at topMargin.
export function cellPos(col, row, offsetX, offsetY, grid) {
  return {
    x: grid.sideMargin + grid.cellW / 2 + col * grid.cellW + offsetX,
    y: grid.topMargin + row * grid.cellH + offsetY,
  };
}

// Count of live sentinels.
export function liveCount(formation) {
  let n = 0;
  for (const s of formation.sentinels) if (s.alive) n++;
  return n;
}

// Min/max live column (for wall detection). Returns null if none alive.
export function liveColumnExtent(formation) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of formation.sentinels) {
    if (!s.alive) continue;
    if (s.col < min) min = s.col;
    if (s.col > max) max = s.col;
  }
  if (min === Infinity) return null;
  return { min, max };
}

// Lowest (largest-row) live sentinel pixel y — used for the "landed" lose check.
export function lowestLiveY(formation, grid) {
  let maxRow = -1;
  for (const s of formation.sentinels) {
    if (s.alive && s.row > maxRow) maxRow = s.row;
  }
  if (maxRow < 0) return -Infinity;
  return cellPos(0, maxRow, formation.offsetX, formation.offsetY, grid).y;
}

// --- stepping ------------------------------------------------------------------------- //

// Step interval (ms) for the current formation. Accelerates as the grid thins (fraction of
// sentinels alive) and across waves (waveSpeedup^(wave-1) shrinks the base). Clamped to floor.
export function stepInterval(formation, grid, step, wave = 1) {
  const total = grid.cols * grid.rows;
  const alive = liveCount(formation);
  const frac = total > 0 ? alive / total : 0; // 1 (full) -> ~0 (almost empty)
  const waveBase = step.baseStepMs * Math.pow(step.waveSpeedup, wave - 1);
  // Interpolate base..min by how thin the ranks are.
  const ms = step.minStepMs + (waveBase - step.minStepMs) * frac;
  return Math.max(step.minStepMs, Math.round(ms));
}

// Advance the formation one march STEP. PURE: returns a NEW formation.
// Moves sideways by marchX in the current dir; if that would push any LIVE sentinel past a
// side margin, instead reverse dir AND drop down by dropY (classic march-and-descend).
export function stepFormation(formation, grid, fieldWidth) {
  const ext = liveColumnExtent(formation);
  if (!ext) return { ...formation }; // nothing alive; no-op

  const nextOffsetX = formation.offsetX + formation.dir * grid.marchX;
  // Pixel extents of the live edge columns AFTER the tentative move.
  const leftX = cellPos(ext.min, 0, nextOffsetX, formation.offsetY, grid).x - grid.sentinelRadius;
  const rightX = cellPos(ext.max, 0, nextOffsetX, formation.offsetY, grid).x + grid.sentinelRadius;

  const hitsLeft = leftX < grid.sideMargin;
  const hitsRight = rightX > fieldWidth - grid.sideMargin;

  if (hitsLeft || hitsRight) {
    // reverse + drop (do NOT also translate sideways this step)
    return {
      ...formation,
      dir: -formation.dir,
      offsetY: formation.offsetY + grid.dropY,
    };
  }
  return { ...formation, offsetX: nextOffsetX };
}

// --- bolt collision ------------------------------------------------------------------- //

// Find the live sentinel a player bolt (a point with radius) overlaps, else -1 (index into
// formation.sentinels). Uses circle/point overlap at each sentinel's current pixel center.
export function boltHitsSentinel(boltPos, boltRadius, formation, grid) {
  for (let i = 0; i < formation.sentinels.length; i++) {
    const s = formation.sentinels[i];
    if (!s.alive) continue;
    const c = cellPos(s.col, s.row, formation.offsetX, formation.offsetY, grid);
    const dx = boltPos.x - c.x;
    const dy = boltPos.y - c.y;
    if (Math.hypot(dx, dy) <= grid.sentinelRadius + boltRadius) return i;
  }
  return -1;
}

// Mark a sentinel dead. PURE: returns a NEW formation with that index killed.
export function killSentinel(formation, index) {
  const sentinels = formation.sentinels.map((s, i) => (i === index ? { ...s, alive: false } : s));
  return { ...formation, sentinels };
}

// Score for a sentinel at `row`, by the rowScore tier table (clamped to the last entry).
export function rowScoreFor(row, rowScore) {
  if (row < rowScore.length) return rowScore[row];
  return rowScore[rowScore.length - 1];
}

// --- enemy firing --------------------------------------------------------------------- //

// The lowest live sentinel in each column (the one that can fire). Returns a map col->index,
// excluding empty columns. Bolts originate from these so fire comes from the formation's
// underside, like the classic.
export function bottomShooters(formation, grid) {
  const byCol = new Map();
  for (let i = 0; i < formation.sentinels.length; i++) {
    const s = formation.sentinels[i];
    if (!s.alive) continue;
    const cur = byCol.get(s.col);
    if (cur === undefined || formation.sentinels[cur].row < s.row) byCol.set(s.col, i);
  }
  return byCol;
}

// Pick a random column's bottom shooter to fire, returning its pixel origin (or null if no
// shooters / the dice say no). `rng` returns [0,1). Caller enforces max-on-screen / cadence.
export function chooseEnemyShot(formation, grid, dropChance, rng = Math.random) {
  if (rng() > dropChance) return null;
  const shooters = bottomShooters(formation, grid);
  if (shooters.size === 0) return null;
  const cols = [...shooters.keys()];
  const col = cols[Math.floor(rng() * cols.length)];
  const idx = shooters.get(col);
  const s = formation.sentinels[idx];
  return cellPos(s.col, s.row, formation.offsetX, formation.offsetY, grid);
}

// --- cover (destructible arcs) -------------------------------------------------------- //

// Build the cover arcs, evenly spaced across the field, each with `cells` erosion health.
//   returns [{ x, y, cells, maxCells }]
export function makeCovers(coverCfg, fieldWidth) {
  const covers = [];
  const n = coverCfg.count;
  // distribute centers across the playable width with even gaps
  for (let i = 0; i < n; i++) {
    const x = ((i + 1) / (n + 1)) * fieldWidth;
    covers.push({ x, y: coverCfg.y, cells: coverCfg.cells, maxCells: coverCfg.cells });
  }
  return covers;
}

// Does a bolt overlap a (still-intact) cover? Returns the cover index or -1.
export function boltHitsCover(boltPos, boltRadius, covers, coverCfg) {
  for (let i = 0; i < covers.length; i++) {
    const cv = covers[i];
    if (cv.cells <= 0) continue;
    const dx = boltPos.x - cv.x;
    const dy = boltPos.y - cv.y;
    if (Math.hypot(dx, dy) <= coverCfg.radius + boltRadius) return i;
  }
  return -1;
}

// Erode a cover by one cell (a hit chips it). PURE: returns a NEW covers array.
export function erodeCover(covers, index) {
  return covers.map((cv, i) => (i === index ? { ...cv, cells: Math.max(0, cv.cells - 1) } : cv));
}

// --- bolts (shared linear movers) ----------------------------------------------------- //

// Advance vertical bolts by their signed speed*dt, dropping any that leave the field.
// `bolts` = [{ x, y, vy }]; PURE: returns a new array.
export function stepVerticalBolts(bolts, dt, fieldHeight) {
  const out = [];
  for (const b of bolts) {
    const y = b.y + b.vy * dt;
    if (y < -20 || y > fieldHeight + 20) continue;
    out.push({ ...b, y });
  }
  return out;
}

// --- player --------------------------------------------------------------------------- //

// Clamp the player's x to the play area given its width and side margin. PURE.
export function clampPlayerX(x, playerCfg, fieldWidth) {
  const half = playerCfg.width / 2;
  const lo = playerCfg.margin + half;
  const hi = fieldWidth - playerCfg.margin - half;
  return Math.max(lo, Math.min(hi, x));
}

// AABB-ish point/box check: does a downward enemy bolt hit the player ship? The player is a
// box centered at (px, py); the bolt is a point with a small half-extent.
export function enemyBoltHitsPlayer(boltPos, playerX, playerCfg) {
  const halfW = playerCfg.width / 2;
  const halfH = playerCfg.height / 2;
  return (
    Math.abs(boltPos.x - playerX) <= halfW &&
    Math.abs(boltPos.y - playerCfg.y) <= halfH
  );
}
