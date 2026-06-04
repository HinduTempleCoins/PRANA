// Pure, side-effect-free Wallbreaker logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// Geometry is in abstract play-field units (the scene scales to pixels). The field is a
// rectangle [0,fieldW] × [0,fieldH]; y grows downward; the paddle sits near the bottom and
// the brick grid near the top.

export const FIELD = { w: 800, h: 600 };

// Brick field: 8 columns × 6 rows. Row colour tiers map to HP (top rows are tougher).
export const BRICKS = { cols: 8, rows: 6, top: 60, gap: 6, height: 28, sideMargin: 30 };

// HP tier per row (row 0 = top). Tougher bricks up top — clearing eats into them last.
export const ROW_HP = [3, 3, 2, 2, 1, 1];

// Colour per HP tier (rendered by the scene; kept here so logic+art agree).
export const HP_COLOR = { 3: '#ff6a7a', 2: '#ffd27f', 1: '#7fd6ff' };

// --- brick field construction --------------------------------------------------------- //

// Build the brick grid as a flat list of { col, row, x, y, w, h, hp, alive }.
export function buildBricks(field = FIELD, cfg = BRICKS, rowHp = ROW_HP) {
  const usableW = field.w - cfg.sideMargin * 2;
  const brickW = (usableW - cfg.gap * (cfg.cols - 1)) / cfg.cols;
  const bricks = [];
  for (let row = 0; row < cfg.rows; row++) {
    for (let col = 0; col < cfg.cols; col++) {
      const x = cfg.sideMargin + col * (brickW + cfg.gap);
      const y = cfg.top + row * (cfg.height + cfg.gap);
      bricks.push({
        col,
        row,
        x,
        y,
        w: brickW,
        h: cfg.height,
        hp: rowHp[row] ?? 1,
        maxHp: rowHp[row] ?? 1,
        alive: true,
      });
    }
  }
  return bricks;
}

// How many bricks are still alive.
export function aliveCount(bricks) {
  let n = 0;
  for (const b of bricks) if (b.alive) n++;
  return n;
}

// --- paddle "english" (bounce angle from contact point) ------------------------------- //
//
// Where the ball hits the paddle steers the rebound: dead-centre = straight up, edges = steep
// outward angle. `hitX` and the paddle span define an offset in [-1,1]; we map that to a
// launch angle within [-maxAngle, +maxAngle] off vertical, preserving the ball's speed.
export const MAX_BOUNCE_ANGLE = (60 * Math.PI) / 180; // 60° off vertical at the very edge

// Normalised contact offset in [-1,1]: -1 = left edge, 0 = centre, +1 = right edge.
export function paddleOffset(ballX, paddleX, paddleW) {
  const half = paddleW / 2;
  const center = paddleX + half;
  const off = (ballX - center) / half;
  return Math.max(-1, Math.min(1, off));
}

// Given the current speed and a contact offset, return the post-bounce velocity {vx, vy}.
// vy is always negative (upward) after a paddle hit. Speed (magnitude) is preserved.
export function paddleBounce(speed, offset, maxAngle = MAX_BOUNCE_ANGLE) {
  const clamped = Math.max(-1, Math.min(1, offset));
  const angle = clamped * maxAngle; // off vertical
  const vx = speed * Math.sin(angle);
  const vy = -speed * Math.cos(angle); // upward
  return { vx, vy };
}

export function speedOf(vx, vy) {
  return Math.hypot(vx, vy);
}

// --- wall bounces --------------------------------------------------------------------- //
//
// Reflect the ball off the left/right/top walls. Returns the (possibly) reflected velocity
// AND a clamped position so the ball never tunnels past a wall. `r` is the ball radius.
// The BOTTOM is intentionally NOT a wall here — falling past the bottom is a life lost.
export function reflectWalls(pos, vel, r, field = FIELD) {
  let { x, y } = pos;
  let { vx, vy } = vel;
  let hit = false;
  if (x - r < 0) {
    x = r;
    vx = Math.abs(vx);
    hit = true;
  } else if (x + r > field.w) {
    x = field.w - r;
    vx = -Math.abs(vx);
    hit = true;
  }
  if (y - r < 0) {
    y = r;
    vy = Math.abs(vy);
    hit = true;
  }
  return { pos: { x, y }, vel: { vx, vy }, hit };
}

// Did the ball fall past the bottom edge (life lost)?
export function fellOff(pos, r, field = FIELD) {
  return pos.y - r > field.h;
}

// --- brick collision ------------------------------------------------------------------ //
//
// Axis-aligned circle-vs-rect test for the ball against one brick. Returns the reflection
// axis ('x' | 'y' | null). We pick the axis by the shallower overlap (the side the ball
// most likely came from), which gives believable single-axis reflections.
export function brickHitAxis(pos, r, brick) {
  if (!brick.alive) return null;
  // closest point on the brick rect to the ball centre
  const cx = Math.max(brick.x, Math.min(pos.x, brick.x + brick.w));
  const cy = Math.max(brick.y, Math.min(pos.y, brick.y + brick.h));
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  if (dx * dx + dy * dy > r * r) return null; // no overlap

  // overlap depths along each axis (how far the ball centre is inside, plus radius)
  const overlapX = r - Math.abs(dx);
  const overlapY = r - Math.abs(dy);
  // If the ball centre is inside on one axis (dx or dy == 0), reflect on the other.
  if (dx === 0 && dy === 0) return 'y'; // dead-centre: treat as a vertical hit
  if (Math.abs(dx) < 1e-9) return 'y';
  if (Math.abs(dy) < 1e-9) return 'x';
  return overlapX < overlapY ? 'x' : 'y';
}

// Apply a hit to a brick: decrement HP, mark dead at 0. Returns { destroyed, hp }.
export function damageBrick(brick) {
  brick.hp -= 1;
  if (brick.hp <= 0) {
    brick.hp = 0;
    brick.alive = false;
    return { destroyed: true, hp: 0 };
  }
  return { destroyed: false, hp: brick.hp };
}

// Reflect a velocity on the given axis ('x' | 'y').
export function reflect(vel, axis) {
  if (axis === 'x') return { vx: -vel.vx, vy: vel.vy };
  if (axis === 'y') return { vx: vel.vx, vy: -vel.vy };
  return { ...vel };
}

// --- scoring -------------------------------------------------------------------------- //
//
// Points scale with how tough the brick was (its maxHp tier) and the current level.
export function brickScore(brick, level = 0) {
  const tier = brick.maxHp ?? 1;
  return tier * 50 * (level + 1);
}

// Bonus for clearing the whole field at a level.
export function clearBonus(level = 0) {
  return 1000 * (level + 1);
}

// --- level scaling -------------------------------------------------------------------- //
//
// Each cleared field advances the level and speeds the ball up by +10% (compounding),
// clamped to a max so it never becomes uncontrollable.
export const BASE_BALL_SPEED = 360; // field-units per second
export const SPEED_PER_LEVEL = 1.1; // +10% per level
export const MAX_BALL_SPEED = 760;

export function ballSpeedForLevel(level, base = BASE_BALL_SPEED, factor = SPEED_PER_LEVEL, max = MAX_BALL_SPEED) {
  return Math.min(max, base * Math.pow(factor, level));
}

// Rescale a velocity vector to a target speed, preserving its direction.
export function rescaleVelocity(vel, targetSpeed) {
  const s = speedOf(vel.vx, vel.vy);
  if (s === 0) return { vx: 0, vy: -targetSpeed }; // degenerate: shoot straight up
  const k = targetSpeed / s;
  return { vx: vel.vx * k, vy: vel.vy * k };
}

// --- powerups (kept tight: wide paddle + multiball) ----------------------------------- //

export const POWERUPS = { WIDE: 'wide', MULTI: 'multi' };

// On a brick break, maybe drop a powerup. `rng` in [0,1); `chance` is the drop probability.
// Returns a powerup type string or null. Deterministic given the rng.
export function maybeDropPowerup(rng = Math.random, chance = 0.12) {
  if (rng() >= chance) return null;
  return rng() < 0.5 ? POWERUPS.WIDE : POWERUPS.MULTI;
}

// Widen the paddle (capped). Returns the new width.
export function widenPaddle(width, factor = 1.5, max = 240) {
  return Math.min(max, width * factor);
}

// Multiball: given a base velocity, return TWO extra velocities fanned out by ±angle,
// each at the same speed. Used to spawn the extra balls.
export function splitBall(vel, angle = (20 * Math.PI) / 180) {
  const speed = speedOf(vel.vx, vel.vy) || BASE_BALL_SPEED;
  const baseAngle = Math.atan2(vel.vy, vel.vx);
  const a1 = baseAngle - angle;
  const a2 = baseAngle + angle;
  return [
    { vx: speed * Math.cos(a1), vy: speed * Math.sin(a1) },
    { vx: speed * Math.cos(a2), vy: speed * Math.sin(a2) },
  ];
}

// --- paddle position clamp ------------------------------------------------------------ //

// Keep the paddle fully inside the field.
export function clampPaddle(x, paddleW, field = FIELD) {
  return Math.max(0, Math.min(field.w - paddleW, x));
}
