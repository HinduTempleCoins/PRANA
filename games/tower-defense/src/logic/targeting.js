// Pure, side-effect-free game logic. Imported by PlayScene AND exercised by node --test.
// No Phaser imports here on purpose — keeps it testable in plain node.

export function distance(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// Nearest-in-range target selection.
// `tower`  : { x, y, stats:{ range } }
// `enemies`: [{ x, y, hp, alive }] — only living, positive-hp enemies are eligible.
// Returns the nearest eligible enemy within range, or null.
export function nearestInRange(tower, enemies) {
  const range = tower?.stats?.range ?? 0;
  let best = null;
  let bestDist = Infinity;
  for (const e of enemies) {
    if (!e || e.alive === false || e.hp <= 0) continue;
    const d = distance(tower.x, tower.y, e.x, e.y);
    if (d <= range && d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

// Damage applied per projectile hit. Kept trivial now but isolated so balancing/level
// scaling lives in one tested place. Level adds a small linear bonus.
export function shotDamage(stats) {
  const base = stats?.damage ?? 0;
  const level = stats?.level ?? 1;
  return base + Math.max(0, level - 1) * Math.ceil(base * 0.1);
}

// Apply damage to an enemy hp value. Returns { hp, killed }.
export function applyDamage(hp, dmg) {
  const next = hp - dmg;
  return { hp: Math.max(0, next), killed: next <= 0 };
}

// Difficulty scaling per wave. Enemy hp and count both grow; bounty grows slower so the
// economy stays tight. Pure so tuning is testable.
export function waveSpec(wave) {
  const count = 5 + Math.floor(wave * 1.5);
  const hp = Math.round(20 * Math.pow(1.18, wave - 1));
  const speed = 40 + wave * 3; // px/sec
  const bounty = 5 + Math.floor(wave / 2);
  return { count, hp, speed, bounty };
}
