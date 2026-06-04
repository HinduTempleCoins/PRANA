// Pure, side-effect-free Snake logic. Imported by PlayScene AND exercised by node --test.
// No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// Coordinates are grid cells: { x: col, y: row }. The snake body is an array of cells,
// body[0] is the HEAD, body[body.length-1] is the TAIL.

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// Is `next` a 180° reversal of `current`? A length>1 snake may not reverse into itself.
export function isReversal(current, next) {
  return OPPOSITE[current] === next;
}

// Resolve a requested direction against the current heading.
// Rejects a 180° reversal (returns the current heading unchanged) so the queued input
// can never instantly kill the snake. Unknown directions are ignored.
export function resolveDirection(current, requested) {
  if (!requested || !DIRS[requested]) return current;
  if (isReversal(current, requested)) return current;
  return requested;
}

// Wrap a coordinate component into [0, size).
function wrapComponent(v, size) {
  return ((v % size) + size) % size;
}

// Compute the next head cell from the current head + direction, applying wrap or wall rules.
// Returns { head, outOfBounds }. With wrap=true, outOfBounds is always false (the head wraps).
export function nextHead(head, dir, cols, rows, wrap) {
  const d = DIRS[dir];
  let nx = head.x + d.x;
  let ny = head.y + d.y;
  if (wrap) {
    return { head: { x: wrapComponent(nx, cols), y: wrapComponent(ny, rows) }, outOfBounds: false };
  }
  const outOfBounds = nx < 0 || nx >= cols || ny < 0 || ny >= rows;
  return { head: { x: nx, y: ny }, outOfBounds };
}

export function cellsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

// Does `cell` collide with any segment in `body`? `ignoreTail` excludes the last segment,
// which is correct when the snake is moving WITHOUT eating (the tail vacates the cell).
export function hitsBody(cell, body, ignoreTail = false) {
  const end = ignoreTail ? body.length - 1 : body.length;
  for (let i = 0; i < end; i++) {
    if (cellsEqual(cell, body[i])) return true;
  }
  return false;
}

// Advance the snake one step. PURE: returns a NEW state, never mutates the input.
//
// state = { body:[{x,y}...], dir, grew, alive }
// opts  = { cols, rows, wrap, food:{x,y}|null }
//
// Returns { body, dir, grew, alive, ate, dead, outOfBounds }.
//   - ate         : true if the new head landed on `food`.
//   - grew        : true if the snake grew this step (tail retained).
//   - dead        : true if this step killed the snake (wall or self-collision).
//   - outOfBounds : true if a solid-wall hit caused the death.
export function step(state, opts) {
  const { cols, rows, wrap, food } = opts;
  const dir = state.dir;
  const { head, outOfBounds } = nextHead(state.body[0], dir, cols, rows, wrap);

  if (outOfBounds) {
    return { ...state, alive: false, dead: true, ate: false, grew: false, outOfBounds: true };
  }

  const ate = !!food && cellsEqual(head, food);

  // When eating, the tail is RETAINED (snake grows), so the tail cell is still occupied and
  // must be considered for self-collision. When not eating, the tail vacates — ignore it.
  const selfHit = hitsBody(head, state.body, !ate);
  if (selfHit) {
    return { ...state, alive: false, dead: true, ate, grew: false, outOfBounds: false };
  }

  const newBody = [head, ...state.body];
  if (!ate) newBody.pop(); // move: drop the tail. eat: keep it (grow by one).

  return {
    body: newBody,
    dir,
    grew: ate,
    alive: true,
    ate,
    dead: false,
    outOfBounds: false,
  };
}

// Spawn an orb on a free cell, given a deterministic rng in [0,1). Returns {x,y} or null
// if the board is full (a win/no-space condition). `rng` defaults to Math.random.
export function spawnFood(body, cols, rows, rng = Math.random) {
  const total = cols * rows;
  if (body.length >= total) return null;
  const occupied = new Set(body.map((c) => c.y * cols + c.x));
  const free = [];
  for (let i = 0; i < total; i++) {
    if (!occupied.has(i)) free.push(i);
  }
  const pick = free[Math.floor(rng() * free.length)];
  return { x: pick % cols, y: Math.floor(pick / cols) };
}

// --- scoring -------------------------------------------------------------------------- //

// Multiplier rises with length milestones: one extra x per `every` segments grown.
// `grown` = current length minus the starting length (>= 0). multiplier starts at 1.
export function multiplierFor(grown, every) {
  if (grown <= 0) return 1;
  return 1 + Math.floor(grown / every);
}

// Score added for eating one orb at a given multiplier.
export function orbScore(pointsPerOrb, multiplier) {
  return pointsPerOrb * multiplier;
}

// Step interval (ms) for the current length: speed ramps gently as the snake grows,
// clamped to a floor so it never becomes unplayable.
export function stepInterval(length, rules) {
  const grown = Math.max(0, length - rules.startLength);
  const ms = rules.baseStepMs - grown * rules.speedRampPerSegment;
  return Math.max(rules.minStepMs, Math.round(ms));
}

// Build the initial snake body of `startLength`, centered, heading right.
// Head is first; the tail trails to the left so the first move is legal.
export function initialBody(cols, rows, startLength) {
  const cy = Math.floor(rows / 2);
  const headX = Math.floor(cols / 2);
  const body = [];
  for (let i = 0; i < startLength; i++) {
    body.push({ x: headX - i, y: cy });
  }
  return body;
}
