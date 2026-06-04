// Hand-rolled segment physics for PRANA Ley Rider.
//
// PURE FUNCTIONS ONLY — no Phaser, no globals, no time-of-day. Everything here is exercised
// directly by `node --test`. The render layer (RideScene) owns the canvas/camera and calls
// `stepRider` once per frame with the current track + dt.
//
// Model: the rider is a single circle body (radius = PHYSICS.collisionRadius). Each step:
//   1. integrate velocity from gravity + a mild quadratic-ish air drag,
//   2. integrate position,
//   3. find the nearest track segment within the collision radius,
//   4. if penetrating, project the body out along the segment normal (resolve penetration),
//      kill the inward normal velocity (restitution ~0 => slide, don't bounce), and
//   5. apply tangential friction; boost segments instead ADD a tangential impulse.
//
// Lines are stored as [x1, y1, x2, y2, type] where type is 'n' (normal) or 'b' (boost).

export const LINE_NORMAL = 'n';
export const LINE_BOOST = 'b';

// Closest point on segment AB to point P, plus the parametric t in [0,1].
export function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { x: ax, y: ay, t: 0 }; // degenerate segment
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return { x: ax + t * abx, y: ay + t * aby, t };
}

// Find the nearest segment to (px,py). Returns the contact info or null if none within
// `radius`. Contact carries the unit normal pointing FROM the segment TOWARD the body, the
// unit tangent (in the segment's natural direction A->B), the penetration depth, and the
// line type so boost handling can branch.
export function nearestContact(px, py, lines, radius) {
  let best = null;
  let bestDist = radius;
  for (let i = 0; i < lines.length; i++) {
    const [ax, ay, bx, by, type] = lines[i];
    const cp = closestPointOnSegment(px, py, ax, ay, bx, by);
    const dx = px - cp.x;
    const dy = py - cp.y;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      // Tangent along A->B (normalized).
      let tx = bx - ax;
      let ty = by - ay;
      const tlen = Math.hypot(tx, ty) || 1;
      tx /= tlen;
      ty /= tlen;
      // Normal points from contact point to the body. If the body sits exactly on the line
      // (dist ~ 0), derive a normal perpendicular to the tangent (pointing "up": -y biased).
      let nx;
      let ny;
      if (dist > 1e-6) {
        nx = dx / dist;
        ny = dy / dist;
      } else {
        nx = -ty;
        ny = tx;
        if (ny > 0) {
          nx = -nx;
          ny = -ny;
        } // bias the normal upward so resting bodies are pushed up
      }
      best = {
        index: i,
        type: type || LINE_NORMAL,
        nx,
        ny,
        tx,
        ty,
        penetration: radius - dist,
        contactX: cp.x,
        contactY: cp.y,
      };
    }
  }
  return best;
}

// Clamp speed to maxSpeed (in place on a {vx,vy} object). Returns the object.
function clampSpeed(state, maxSpeed) {
  const sp = Math.hypot(state.vx, state.vy);
  if (sp > maxSpeed) {
    const k = maxSpeed / sp;
    state.vx *= k;
    state.vy *= k;
  }
  return state;
}

// Advance the rider one fixed step.
//   rider: { x, y, vx, vy }          (mutated copy returned)
//   lines: [[x1,y1,x2,y2,type], ...]
//   dt:    seconds (use a fixed step, e.g. 1/120, for determinism)
//   P:     PHYSICS config object (see config.js)
// Returns a NEW rider state plus { contact } (the resolved contact this step, or null).
export function stepRider(rider, lines, dt, P) {
  let { x, y, vx, vy } = rider;

  // 1. gravity + air drag. Drag opposes velocity and scales with speed (quadratic-ish), but
  // is applied per-SECOND (scaled by dt) so it is frame-rate independent and stays a gentle
  // bleed rather than dominating the step. `drag` is the per-step retention factor.
  vy += P.gravity * dt;
  const speed = Math.hypot(vx, vy);
  const drag = 1 - Math.min(0.5, P.airDamping * speed * dt);
  vx *= drag;
  vy *= drag;

  // 2. integrate position.
  x += vx * dt;
  y += vy * dt;

  // 3. nearest contact.
  const contact = nearestContact(x, y, lines, P.collisionRadius);

  if (contact && contact.penetration > 0) {
    // 4. resolve penetration: push the body out along the normal.
    x += contact.nx * contact.penetration;
    y += contact.ny * contact.penetration;

    // Decompose velocity into normal + tangential components.
    const vn = vx * contact.nx + vy * contact.ny; // along outward normal
    const vt = vx * contact.tx + vy * contact.ty; // along tangent (A->B)

    // Remove inward normal velocity; apply restitution to any outward part.
    // Inward means vn < 0 (moving against the outward normal, i.e. into the surface).
    let newVn = vn;
    if (vn < 0) newVn = -vn * P.restitution; // ~0 => no bounce
    // 5. tangential friction (or boost acceleration on boost lines). Friction is a per-step
    // retention applied while in contact; the configured rate is per (1/120 s) reference step
    // and scaled by dt/(1/120) so the feel is frame-rate independent. Boost lines use a
    // NEGATIVE friction (net acceleration) plus a flat tangential impulse.
    const stepScale = dt * 120;
    let newVt = vt;
    if (contact.type === LINE_BOOST) {
      newVt = vt * (1 - P.boostFriction * stepScale);
      newVt += Math.sign(vt || 1) * P.boostImpulse * stepScale;
    } else {
      newVt = vt * (1 - P.friction * stepScale);
    }

    // Recompose velocity from the (possibly modified) normal + tangential parts.
    vx = contact.nx * newVn + contact.tx * newVt;
    vy = contact.ny * newVn + contact.ty * newVt;
  }

  const clamped = clampSpeed({ vx, vy }, P.maxSpeed);
  vx = clamped.vx;
  vy = clamped.vy;

  return { x, y, vx, vy, contact: contact && contact.penetration > 0 ? contact : null };
}

// Lowest (max-y) point across all track endpoints. Used for fall-off-world detection.
export function lowestTrackY(lines, startY = 0, finishY = 0) {
  let maxY = Math.max(startY, finishY);
  for (const [, y1, , y2] of lines) {
    if (y1 > maxY) maxY = y1;
    if (y2 > maxY) maxY = y2;
  }
  return maxY;
}

// Has the rider fallen off the world (below the lowest track point + margin)?
export function isOffWorld(riderY, lines, P, startY = 0, finishY = 0) {
  return riderY > lowestTrackY(lines, startY, finishY) + P.fallMargin;
}

// Has the rider reached the finish flag (within capture radius)?
export function reachedFinish(riderX, riderY, finish, captureRadius) {
  if (!finish) return false;
  return Math.hypot(riderX - finish[0], riderY - finish[1]) <= captureRadius;
}
