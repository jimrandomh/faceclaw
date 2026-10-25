// Headless verification harness for the pinball worker's table geometry and
// physics. Ported 1:1 from app/workers/pinball-app.worker.ts (keep in sync by
// hand if the worker changes). Renders the table plus simulated trajectories
// to grayscale PGM files and logs events/anomalies.
const fs = require("fs");

// --- geometry (must match worker) ---
const LEFT = 10, RIGHT = 260, TOP = 4, BOTTOM = 256, LANE_X = 232;
const BALL_R = 6;
const PLUNGER_X = (LANE_X + RIGHT) / 2, PLUNGER_Y = 240;
const GRAVITY = 240, DRAG_PER_S = 0.12, MAX_SPEED = 600, PHYSICS_DT = 1 / 120;
const LAUNCH_SPEEDS = [320, 380, 440, 500, 560];
const BUMPER_KICK = 340, SLING_KICK = 300;
const FLIPPER_LEN = 37, FLIPPER_R = 5;
const FLIPPER_REST_DEG = 32, FLIPPER_UP_DEG = -34;
const FLIPPER_RISE_DEG_PER_S = 950, FLIPPER_FALL_DEG_PER_S = 480;
const FLIPPER_HOLD_MS = 140, FLIPPER_E = 0.4;

function seg(x0, y0, x1, y1, e, shade = 150, kind = "wall") {
  return { x0, y0, x1, y1, e, kind, shade };
}
function chain(points, e, shade = 150) {
  const out = [];
  for (let i = 1; i < points.length; i++)
    out.push(seg(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], e, shade));
  return out;
}
const SEGMENTS = [
  ...chain([[LEFT, BOTTOM], [LEFT, 54], [16, 24], [34, 8], [58, TOP]], 0.45, 160),
  seg(58, TOP, 210, TOP, 0.45, 160),
  ...chain([[210, TOP], [236, 10], [254, 26], [RIGHT, 56]], 0.35, 160),
  seg(RIGHT, 56, RIGHT, BOTTOM, 0.3, 160),
  seg(LANE_X, BOTTOM, RIGHT, BOTTOM, 0.3, 160),
  seg(LANE_X, 66, LANE_X, BOTTOM, 0.3, 140),
  seg(RIGHT, 56, 226, 68, 0.2, 90, "gate"),
  seg(103, 20, 103, 46, 0.35, 130),
  seg(139, 20, 139, 46, 0.35, 130),
  seg(LEFT, 184, 83, 230.5, 0.35, 150),
  seg(LANE_X, 184, 159, 230.5, 0.35, 150),
  seg(58, 166, 84, 204, 0.4, 170, "sling"),
  seg(58, 166, 58, 196, 0.4, 130),
  seg(58, 196, 84, 204, 0.4, 130),
  seg(184, 166, 158, 204, 0.4, 170, "sling"),
  seg(184, 166, 184, 196, 0.4, 130),
  seg(158, 204, 184, 196, 0.4, 130),
];
const BUMPERS = [
  { x: 75, y: 78, r: 13 },
  { x: 167, y: 78, r: 13 },
  { x: 121, y: 128, r: 13 },
];
const ROLLOVERS = [{ x: 85, y: 34 }, { x: 121, y: 34 }, { x: 157, y: 34 }];
const FLIPPER_PIVOTS = [
  { x: 76, y: 232, mirror: 1 },
  { x: 166, y: 232, mirror: -1 },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeState() {
  return {
    ballX: PLUNGER_X, ballY: PLUNGER_Y, ballVx: 0, ballVy: 0,
    flippers: FLIPPER_PIVOTS.map((p) => ({
      pivotX: p.x, pivotY: p.y, mirror: p.mirror,
      angleDeg: FLIPPER_REST_DEG, state: "rest", holdUntilMs: 0,
    })),
    nowMs: 0, events: [], drained: false,
  };
}

function flipperOmega(f) {
  if (f.state === "rising") return (-FLIPPER_RISE_DEG_PER_S * Math.PI) / 180;
  if (f.state === "falling") return (FLIPPER_FALL_DEG_PER_S * Math.PI) / 180;
  return 0;
}

function stepFlippers(s, dt) {
  for (const f of s.flippers) {
    switch (f.state) {
      case "rising":
        f.angleDeg -= FLIPPER_RISE_DEG_PER_S * dt;
        if (f.angleDeg <= FLIPPER_UP_DEG) {
          f.angleDeg = FLIPPER_UP_DEG; f.state = "hold"; f.holdUntilMs = s.nowMs + FLIPPER_HOLD_MS;
        }
        break;
      case "hold":
        if (s.nowMs >= f.holdUntilMs) f.state = "falling";
        break;
      case "falling":
        f.angleDeg += FLIPPER_FALL_DEG_PER_S * dt;
        if (f.angleDeg >= FLIPPER_REST_DEG) { f.angleDeg = FLIPPER_REST_DEG; f.state = "rest"; }
        break;
    }
  }
}

function collideSegment(s, segment) {
  const dx = segment.x1 - segment.x0, dy = segment.y1 - segment.y0;
  const lengthSq = dx * dx + dy * dy;
  const t = clamp(((s.ballX - segment.x0) * dx + (s.ballY - segment.y0) * dy) / lengthSq, 0, 1);
  const cx = segment.x0 + t * dx, cy = segment.y0 + t * dy;
  const offX = s.ballX - cx, offY = s.ballY - cy;
  const dist = Math.hypot(offX, offY);
  if (dist >= BALL_R || dist === 0) return;
  const nx = offX / dist, ny = offY / dist;
  if (segment.kind === "gate" && ny > -0.3) return;
  s.ballX += nx * (BALL_R - dist);
  s.ballY += ny * (BALL_R - dist);
  const vn = s.ballVx * nx + s.ballVy * ny;
  if (vn >= 0) return;
  if (segment.kind === "sling") {
    s.ballVx = s.ballVx - vn * nx + nx * SLING_KICK;
    s.ballVy = s.ballVy - vn * ny + ny * SLING_KICK;
    s.events.push(`${(s.nowMs / 1000).toFixed(2)}s sling`);
    return;
  }
  s.ballVx -= (1 + segment.e) * vn * nx;
  s.ballVy -= (1 + segment.e) * vn * ny;
}

function collideFlipper(s, f) {
  const angle = (f.angleDeg * Math.PI) / 180;
  const dirX = f.mirror * Math.cos(angle), dirY = Math.sin(angle);
  const relX = s.ballX - f.pivotX, relY = s.ballY - f.pivotY;
  const t = clamp(relX * dirX + relY * dirY, 0, FLIPPER_LEN);
  const cx = f.pivotX + t * dirX, cy = f.pivotY + t * dirY;
  const offX = s.ballX - cx, offY = s.ballY - cy;
  const dist = Math.hypot(offX, offY);
  const reach = BALL_R + FLIPPER_R;
  if (dist >= reach || dist === 0) return;
  const nx = offX / dist, ny = offY / dist;
  s.ballX += nx * (reach - dist);
  s.ballY += ny * (reach - dist);
  const omega = flipperOmega(f);
  const surfaceVx = -t * omega * f.mirror * dirY;
  const surfaceVy = t * omega * f.mirror * dirX;
  const relVn = (s.ballVx - surfaceVx) * nx + (s.ballVy - surfaceVy) * ny;
  if (relVn >= 0) return;
  s.ballVx -= (1 + FLIPPER_E) * relVn * nx;
  s.ballVy -= (1 + FLIPPER_E) * relVn * ny;
}

function collideBumpers(s) {
  for (const b of BUMPERS) {
    const offX = s.ballX - b.x, offY = s.ballY - b.y;
    const dist = Math.hypot(offX, offY);
    const reach = BALL_R + b.r;
    if (dist >= reach || dist === 0) continue;
    const nx = offX / dist, ny = offY / dist;
    s.ballX += nx * (reach - dist);
    s.ballY += ny * (reach - dist);
    const tangential = s.ballVx * -ny + s.ballVy * nx;
    s.ballVx = nx * BUMPER_KICK + -ny * tangential * 0.3;
    s.ballVy = ny * BUMPER_KICK + nx * tangential * 0.3;
    s.events.push(`${(s.nowMs / 1000).toFixed(2)}s bumper`);
  }
}

function stepPhysics(s) {
  const dt = PHYSICS_DT;
  s.nowMs += dt * 1000;
  stepFlippers(s, dt);
  if (s.drained) return;
  s.ballVy += GRAVITY * dt;
  const drag = Math.max(0, 1 - DRAG_PER_S * dt);
  s.ballVx *= drag; s.ballVy *= drag;
  const speed = Math.hypot(s.ballVx, s.ballVy);
  if (speed > MAX_SPEED) { s.ballVx *= MAX_SPEED / speed; s.ballVy *= MAX_SPEED / speed; }
  s.ballX += s.ballVx * dt;
  s.ballY += s.ballVy * dt;
  for (let pass = 0; pass < 2; pass++) {
    for (const segment of SEGMENTS) collideSegment(s, segment);
    for (const f of s.flippers) collideFlipper(s, f);
    collideBumpers(s);
  }
  if (s.ballY > BOTTOM + 2 * BALL_R || s.ballY < TOP - 40 || s.ballX < LEFT - 40 || s.ballX > RIGHT + 40) {
    s.drained = true;
    s.events.push(`${(s.nowMs / 1000).toFixed(2)}s DRAIN at x=${s.ballX.toFixed(0)}`);
  }
}

// --- rendering ---
const W = 276, H = 276;
function render(trailPoints, label) {
  const px = new Uint8Array(W * H);
  const line = (x0, y0, x1, y1, v) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = v;
    }
  };
  for (const s of SEGMENTS) line(s.x0, s.y0, s.x1, s.y1, s.shade);
  for (const b of BUMPERS)
    for (let a = 0; a < 120; a++) {
      const x = Math.round(b.x + b.r * Math.cos((a / 120) * 2 * Math.PI));
      const y = Math.round(b.y + b.r * Math.sin((a / 120) * 2 * Math.PI));
      if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = 130;
    }
  for (const r of ROLLOVERS)
    for (let a = 0; a < 40; a++) {
      const x = Math.round(r.x + 5 * Math.cos((a / 40) * 2 * Math.PI));
      const y = Math.round(r.y + 5 * Math.sin((a / 40) * 2 * Math.PI));
      if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = 110;
    }
  for (const f of FLIPPER_PIVOTS) {
    const a = (FLIPPER_REST_DEG * Math.PI) / 180;
    line(f.x, f.y, f.x + f.mirror * FLIPPER_LEN * Math.cos(a), f.y + FLIPPER_LEN * Math.sin(a), 255);
  }
  for (const [x, y] of trailPoints) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < W && yi < H) px[yi * W + xi] = Math.max(px[yi * W + xi], 220);
  }
  const header = Buffer.from(`P5\n${W} ${H}\n255\n`);
  fs.writeFileSync(`${__dirname}/pinball-${label}.pgm`, Buffer.concat([header, Buffer.from(px)]));
}

// --- scenarios ---
function runScenario(label, power, flipPolicy, maxSeconds = 40) {
  const s = makeState();
  s.ballY = PLUNGER_Y - 2;
  s.ballVy = -LAUNCH_SPEEDS[power - 1];
  const trail = [];
  let stuckMs = 0, stuckReported = null, minY = 999;
  const steps = Math.round(maxSeconds / PHYSICS_DT);
  for (let i = 0; i < steps && !s.drained; i++) {
    stepPhysics(s);
    minY = Math.min(minY, s.ballY);
    if (!Number.isFinite(s.ballX) || !Number.isFinite(s.ballY)) {
      s.events.push(`${(s.nowMs / 1000).toFixed(2)}s NON-FINITE POSITION`);
      break;
    }
    if (i % 4 === 0) trail.push([s.ballX, s.ballY]);
    const speed = Math.hypot(s.ballVx, s.ballVy);
    if (speed < 6) stuckMs += PHYSICS_DT * 1000; else stuckMs = 0;
    // A slow ball near the flippers may just be trapped on one (legitimate);
    // fire the flippers and only call it stuck if that fails to eject it.
    if (stuckMs > 1200 && Math.round(stuckMs) % 600 < PHYSICS_DT * 1000) {
      for (const f of s.flippers) if (f.state === "rest") f.state = "rising";
    }
    if (stuckMs > 2500 && !stuckReported) {
      stuckReported = `STUCK ~2.5s at (${s.ballX.toFixed(0)},${s.ballY.toFixed(0)})`;
      s.events.push(stuckReported);
    }
    flipPolicy(s);
  }
  render(trail, label);
  const outcome = s.drained ? "drained" : stuckReported ? "stuck" : "still live at timeout";
  console.log(`\n=== ${label} (power ${power}): ${outcome}, minY=${minY.toFixed(0)}, ${(s.nowMs / 1000).toFixed(1)}s sim ===`);
  const counts = {};
  for (const e of s.events) {
    const kind = e.split(" ")[1] || e;
    counts[kind] = (counts[kind] || 0) + 1;
  }
  console.log("events:", JSON.stringify(counts));
  console.log("last events:", s.events.slice(-6).join(" | "));
}

const noFlips = () => {};
// Flip both flippers whenever the ball descends into the flipper zone.
function reactiveFlips(s) {
  if (s.ballVy > 0 && s.ballY > 195 && s.ballY < 235 && s.ballX > 55 && s.ballX < 190) {
    for (const f of s.flippers) if (f.state === "rest") f.state = "rising";
  }
}

runScenario("p1-noflip", 1, noFlips);
runScenario("p3-noflip", 3, noFlips);
runScenario("p5-noflip", 5, noFlips);
runScenario("p4-flips", 4, reactiveFlips, 90);
runScenario("p2-flips", 2, reactiveFlips, 90);

// Randomized robustness sweep: random power, jittery/erratic flipping.
let bad = 0;
for (let run = 0; run < 30; run++) {
  const power = 1 + Math.floor(Math.random() * 5);
  const policy = (s) => {
    if (Math.random() < 0.004) {
      const f = s.flippers[Math.floor(Math.random() * 2)];
      if (f.state === "rest") f.state = "rising";
    }
    reactiveFlips(s);
  };
  const s = makeState();
  s.ballY = PLUNGER_Y - 2;
  s.ballVy = -LAUNCH_SPEEDS[power - 1];
  let stuckMs = 0, failed = null;
  for (let i = 0; i < Math.round(120 / PHYSICS_DT) && !s.drained; i++) {
    stepPhysics(s);
    if (!Number.isFinite(s.ballX) || !Number.isFinite(s.ballY)) { failed = "non-finite"; break; }
    const speed = Math.hypot(s.ballVx, s.ballVy);
    if (speed < 6) stuckMs += PHYSICS_DT * 1000; else stuckMs = 0;
    if (stuckMs > 1200 && Math.round(stuckMs) % 600 < PHYSICS_DT * 1000) {
      for (const f of s.flippers) if (f.state === "rest") f.state = "rising";
    }
    if (stuckMs > 2500) { failed = `stuck at (${s.ballX.toFixed(0)},${s.ballY.toFixed(0)})`; break; }
    policy(s);
  }
  if (failed) { bad++; console.log(`run ${run} power ${power}: ${failed}`); }
}
console.log(`\nrandom sweep: ${bad}/30 runs failed`);
