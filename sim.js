const G = 1800, SOFTEN = 8, SOFTEN2 = 64, STEP = 1 / 120;
const MAX_BODIES = 36, TRAIL_CAP = 160, CULL = 14000, MAX_SPEED = 2400;
const FLING = 1.35, ZOOM_MIN = 0.12, ZOOM_MAX = 3.6;
const PREDICT_STEPS = 180, PREDICT_DT = 1 / 60;

const PALETTE = [
  { color: "#8aa6b8", glow: "#c5d8e4" },
  { color: "#c48968", glow: "#e4c0a8" },
  { color: "#8a9e7a", glow: "#c5d4b4" },
  { color: "#c2b48a", glow: "#e4dcc0" },
  { color: "#7a8a9a", glow: "#b8c4d0" },
  { color: "#b88880", glow: "#e0c4be" },
];
const PRESETS = {
  moon: { kind: "moon", mass: 2.4, label: "Moon", color: "#c5c8ce", glow: "#e8eaf0" },
  planet: { kind: "planet", mass: 14, label: "Planet", color: "#8aa6b8", glow: "#c5d8e4" },
  star: { kind: "star", mass: 720, label: "Star", color: "#efe6c8", glow: "#fff6d4" },
  hole: { kind: "hole", mass: 1400, label: "Hole", color: "#050506", glow: "#e8d4b0" },
};

function radiusFor(kind, mass) {
  const m = Math.cbrt(Math.max(0.2, mass));
  if (kind === "moon") return Math.max(4.5, 5.4 + 1.15 * m);
  if (kind === "planet") return Math.max(7, 6.5 + 2.35 * m);
  if (kind === "star") return Math.max(16, 14 + 2.7 * m);
  return Math.max(7, 6 + 1.05 * m);
}
function kindFromMerge(mass, a, b) {
  if (a === "hole" || b === "hole" || mass >= 1800) return "hole";
  if (a === "star" || b === "star" || mass >= 420) return "star";
  if (mass >= 8) return "planet";
  return "moon";
}
function parseHex(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
function mixHex(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  return rgbToHex(
    Math.round(pa.r + (pb.r - pa.r) * t),
    Math.round(pa.g + (pb.g - pa.g) * t),
    Math.round(pa.b + (pb.b - pa.b) * t),
  );
}
function rgba(hex, a) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function shade(hex, amt) {
  const { r, g, b } = parseHex(hex);
  const f = (v) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

const EMPTY_TRAIL = new Float32Array(TRAIL_CAP * 2);
function createSim() {
  return { bodies: [], nextId: 1, tick: 0, merges: [], planetPaletteIdx: 0 };
}
function createBody(sim, kind, mass, x, y, vx, vy, color, glow, ephemeral) {
  let c = color, g = glow;
  if (kind === "planet" && !c) {
    const pal = PALETTE[sim.planetPaletteIdx % PALETTE.length];
    sim.planetPaletteIdx += 1;
    c = pal.color; g = pal.glow;
  }
  const preset = PRESETS[kind] || PRESETS.planet;
  return {
    id: sim.nextId++, kind, mass, radius: radiusFor(kind, mass),
    x, y, vx, vy, ax: 0, ay: 0,
    color: c || preset.color, glow: g || preset.glow,
    trail: ephemeral ? EMPTY_TRAIL : new Float32Array(TRAIL_CAP * 2),
    tHead: 0, tCount: 0,
  };
}
function pushTrail(b, x, y) {
  const i = b.tHead * 2;
  b.trail[i] = x; b.trail[i + 1] = y;
  b.tHead = (b.tHead + 1) % TRAIL_CAP;
  if (b.tCount < TRAIL_CAP) b.tCount += 1;
}
function accelerations(bodies) {
  const n = bodies.length;
  for (let i = 0; i < n; i++) { bodies[i].ax = 0; bodies[i].ay = 0; }
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const r2 = dx * dx + dy * dy + SOFTEN2;
      const inv = G / (r2 * Math.sqrt(r2));
      const fx = dx * inv, fy = dy * inv;
      a.ax += fx * b.mass; a.ay += fy * b.mass;
      b.ax -= fx * a.mass; b.ay -= fy * a.mass;
    }
  }
}
function pairCollides(a, b, dt) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const r = a.radius + b.radius, r2 = r * r;
  if (dx * dx + dy * dy <= r2) return true;
  const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
  const bDot = dx * dvx + dy * dvy;
  if (bDot >= 0) return false;
  const aDot = dvx * dvx + dvy * dvy;
  if (aDot < 1e-12) return false;
  const t = Math.max(0, Math.min(dt, -bDot / aDot));
  const mx = dx + dvx * t, my = dy + dvy * t;
  return mx * mx + my * my <= r2;
}
function mergePair(sim, i, j) {
  const bodies = sim.bodies;
  const a = bodies[i], b = bodies[j];
  const keep = a.mass >= b.mass ? a : b;
  const drop = keep === a ? b : a;
  const m = a.mass + b.mass;
  keep.x = (a.x * a.mass + b.x * b.mass) / m;
  keep.y = (a.y * a.mass + b.y * b.mass) / m;
  keep.vx = (a.vx * a.mass + b.vx * b.mass) / m;
  keep.vy = (a.vy * a.mass + b.vy * b.mass) / m;
  keep.kind = kindFromMerge(m, a.kind, b.kind);
  keep.mass = m; keep.ax = 0; keep.ay = 0;
  keep.radius = radiusFor(keep.kind, m);
  const t = drop.mass / m;
  if (keep.kind === "star") { keep.color = PRESETS.star.color; keep.glow = PRESETS.star.glow; }
  else if (keep.kind === "hole") { keep.color = PRESETS.hole.color; keep.glow = PRESETS.hole.glow; }
  else { keep.color = mixHex(keep.color, drop.color, t * 0.5); keep.glow = mixHex(keep.glow, drop.glow, t * 0.5); }
  sim.merges.push({ x: keep.x, y: keep.y, mass: m, radius: keep.radius, color: keep.glow });
  bodies.splice(drop === a ? i : j, 1);
}
function resolveCollisions(sim) {
  let any = false, guard = 0;
  while (guard++ < 48) {
    const bodies = sim.bodies;
    let hit = false;
    outer: for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (pairCollides(bodies[i], bodies[j], 0)) {
          mergePair(sim, i, j); hit = true; any = true; break outer;
        }
      }
    }
    if (!hit) break;
  }
  return any;
}
function resolveSwept(sim, dt) {
  const bodies = sim.bodies;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (pairCollides(bodies[i], bodies[j], dt)) {
        mergePair(sim, i, j);
        return true;
      }
    }
  }
  return false;
}
function stepSim(sim, dt, record) {
  sim.merges.length = 0;
  if (sim.bodies.length === 0) { sim.tick += 1; return; }
  resolveCollisions(sim);
  accelerations(sim.bodies);
  for (const b of sim.bodies) { b.vx += b.ax * dt; b.vy += b.ay * dt; }
  let swept = resolveSwept(sim, dt), guard = 0;
  while (swept && guard++ < 24) swept = resolveSwept(sim, 0);
  for (const b of sim.bodies) { b.x += b.vx * dt; b.y += b.vy * dt; }
  resolveCollisions(sim);
  const lim2 = CULL * CULL, maxSp2 = MAX_SPEED * MAX_SPEED;
  sim.bodies = sim.bodies.filter((b) => {
    if (!Number.isFinite(b.x + b.y + b.vx + b.vy)) return false;
    if (b.x * b.x + b.y * b.y > lim2) return false;
    const sp2 = b.vx * b.vx + b.vy * b.vy;
    if (sp2 > maxSp2) { const s = MAX_SPEED / Math.sqrt(sp2); b.vx *= s; b.vy *= s; }
    return true;
  });
  if (record && sim.tick % 2 === 0) {
    for (const b of sim.bodies) {
      if (b.vx * b.vx + b.vy * b.vy < 64) continue;
      pushTrail(b, b.x, b.y);
    }
  }
  sim.tick += 1;
}
function circularVelocity(px, py, attractor, clockwise) {
  const dx = px - attractor.x, dy = py - attractor.y;
  const r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
  const s2 = r2 + SOFTEN2;
  const a = (G * attractor.mass * r) / (s2 * Math.sqrt(s2));
  const v = Math.sqrt(Math.max(0, a * r));
  const inv = r > 1e-6 ? 1 / r : 0;
  const s = clockwise ? -1 : 1;
  return { vx: -dy * inv * v * s, vy: dx * inv * v * s };
}
function cloneBodies(bodies) {
  return bodies.map((b) => ({ ...b, trail: EMPTY_TRAIL, tHead: 0, tCount: 0 }));
}
function predictPath(sim, ghost, steps, dt) {
  const tmp = { bodies: cloneBodies(sim.bodies), nextId: sim.nextId + 1, tick: 0, merges: [], planetPaletteIdx: 0 };
  const g = createBody(tmp, ghost.kind, ghost.mass, ghost.x, ghost.y, ghost.vx, ghost.vy, ghost.color, ghost.glow, true);
  tmp.bodies.push(g);
  const pts = new Float32Array(steps * 2);
  let n = 0;
  for (let i = 0; i < steps; i++) {
    stepSim(tmp, dt, false);
    const live = tmp.bodies.find((b) => b.id === g.id);
    if (!live) break;
    pts[n * 2] = live.x; pts[n * 2 + 1] = live.y; n += 1;
  }
  return pts.subarray(0, n * 2);
}
function warmUp(sim, seconds) {
  const steps = Math.floor(seconds / STEP);
  for (let i = 0; i < steps; i++) stepSim(sim, STEP, true);
  sim.merges.length = 0;
}
function seedSystem() {
  const s = createSim();
  const star = createBody(s, "star", PRESETS.star.mass, 0, 0, 0, 0);
  s.bodies.push(star);
  const p1 = circularVelocity(168, 18, star);
  s.bodies.push(createBody(s, "planet", 14, 168, 18, p1.vx, p1.vy, "#8aa6b8", "#c5d8e4"));
  const p2 = circularVelocity(-96, 248, star);
  s.bodies.push(createBody(s, "planet", 18, -96, 248, p2.vx * 0.98, p2.vy * 0.98, "#c48968", "#e4c0a8"));
  const p3 = circularVelocity(-310, -140, star);
  s.bodies.push(createBody(s, "planet", 11, -310, -140, p3.vx * 1.02, p3.vy * 1.02, "#c2b48a", "#e4dcc0"));
  warmUp(s, 7.5);
  return s;
}
function seedFigureEight() {
  const s = createSim();
  const L = 92, m = 48, vScale = Math.sqrt((G * m) / L);
  const p1x = 0.97000436 * L, p1y = -0.24308753 * L;
  const v3x = -0.93240737 * vScale, v3y = -0.86473146 * vScale;
  const v1x = -v3x / 2, v1y = -v3y / 2;
  s.bodies.push(createBody(s, "planet", m, p1x, p1y, v1x, v1y, "#8aa6b8", "#c5d8e4"));
  s.bodies.push(createBody(s, "planet", m, -p1x, -p1y, v1x, v1y, "#c48968", "#e4c0a8"));
  s.bodies.push(createBody(s, "planet", m, 0, 0, v3x, v3y, "#c2b48a", "#e4dcc0"));
  warmUp(s, 4.2);
  return s;
}

function hash2(ix, iy, seed) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}
function strongestLight(body, bodies) {
  let best = 0, nx = -0.45, ny = -0.55;
  for (const other of bodies) {
    if (other.id === body.id) continue;
    if (other.kind !== "star" && other.kind !== "hole") continue;
    const dx = other.x - body.x, dy = other.y - body.y;
    const d2 = dx * dx + dy * dy + 1;
    const w = other.mass / d2;
    if (w > best) { best = w; const inv = 1 / Math.sqrt(d2); nx = dx * inv; ny = dy * inv; }
  }
  return { nx, ny };
}
function drawStarfield(ctx, cam, w, h) {
  const layers = [
    { parallax: 0.12, cell: 160, seed: 17, size: 1.1, alpha: 0.38 },
    { parallax: 0.28, cell: 220, seed: 41, size: 1.5, alpha: 0.55 },
    { parallax: 0.5, cell: 280, seed: 73, size: 2.1, alpha: 0.72 },
  ];
  for (const layer of layers) {
    const ox = cam.x * layer.parallax, oy = cam.y * layer.parallax, cell = layer.cell;
    const minX = ox - w / (2 * cam.zoom) - cell, maxX = ox + w / (2 * cam.zoom) + cell;
    const minY = oy - h / (2 * cam.zoom) - cell, maxY = oy + h / (2 * cam.zoom) + cell;
    const ix0 = Math.floor(minX / cell), ix1 = Math.floor(maxX / cell);
    const iy0 = Math.floor(minY / cell), iy1 = Math.floor(maxY / cell);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const hsh = hash2(ix, iy, layer.seed);
        const count = 1 + (hsh % 3);
        for (let n = 0; n < count; n++) {
          const h2 = hash2(ix, iy, layer.seed + 19 * (n + 1));
          const sx = (ix + ((h2 & 255) / 255) * 0.92) * cell;
          const sy = (iy + (((h2 >> 8) & 255) / 255) * 0.92) * cell;
          const twinkle = 0.65 + 0.35 * (((h2 >> 16) & 255) / 255);
          ctx.fillStyle = `rgba(232,233,237,${layer.alpha * twinkle})`;
          ctx.beginPath();
          ctx.arc(sx, sy, (layer.size * (0.6 + ((h2 >> 24) & 255) / 400)) / cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}
function drawTrails(ctx, bodies, zoom) {
  for (const b of bodies) {
    if (b.tCount < 3) continue;
    const start = (b.tHead - b.tCount + TRAIL_CAP) % TRAIL_CAP;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const width = Math.max(1.1 / zoom, b.radius * 0.16);
    const chunks = 6, size = Math.max(1, Math.floor(b.tCount / chunks));
    for (let c = 0; c < chunks; c++) {
      const a = c * size, z = c === chunks - 1 ? b.tCount : Math.min(b.tCount, (c + 1) * size + 1);
      if (z - a < 2) continue;
      const u = (c + 1) / chunks;
      ctx.strokeStyle = rgba(b.glow, u * u * 0.5);
      ctx.lineWidth = width * (0.3 + 0.7 * u);
      ctx.beginPath();
      for (let n = a; n < z; n++) {
        const i = ((start + n) % TRAIL_CAP) * 2;
        if (n === a) ctx.moveTo(b.trail[i], b.trail[i + 1]);
        else ctx.lineTo(b.trail[i], b.trail[i + 1]);
      }
      ctx.stroke();
    }
  }
}
function drawPlanet(ctx, b, bodies) {
  const { nx, ny } = strongestLight(b, bodies);
  const hx = b.x - nx * b.radius * 0.38, hy = b.y - ny * b.radius * 0.38;
  const g = ctx.createRadialGradient(hx, hy, b.radius * 0.08, b.x, b.y, b.radius);
  g.addColorStop(0, shade(b.color, 70)); g.addColorStop(0.45, b.color); g.addColorStop(1, shade(b.color, -70));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.08, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(b.glow, 0.18); ctx.lineWidth = Math.max(0.6, b.radius * 0.06); ctx.stroke();
}
function drawStar(ctx, b, time) {
  const pulse = 0.92 + 0.08 * Math.sin(time * 1.7 + b.id);
  const coronaR = b.radius * 2.45 * pulse;
  const corona = ctx.createRadialGradient(b.x, b.y, b.radius * 0.45, b.x, b.y, coronaR);
  corona.addColorStop(0, rgba(b.glow, 0.38)); corona.addColorStop(0.4, rgba(b.color, 0.12)); corona.addColorStop(1, "rgba(7,8,11,0)");
  ctx.fillStyle = corona; ctx.beginPath(); ctx.arc(b.x, b.y, coronaR, 0, Math.PI * 2); ctx.fill();
  const core = ctx.createRadialGradient(b.x - b.radius * 0.18, b.y - b.radius * 0.2, 0, b.x, b.y, b.radius);
  core.addColorStop(0, "#fffaf0"); core.addColorStop(0.42, b.color); core.addColorStop(1, shade(b.color, -36));
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill();
}
function drawHole(ctx, b, time, zoom) {
  const halo = ctx.createRadialGradient(b.x, b.y, b.radius * 0.6, b.x, b.y, b.radius * 4.2);
  halo.addColorStop(0, "rgba(210,176,130,0.2)"); halo.addColorStop(0.4, "rgba(160,96,60,0.07)"); halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 4.2, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(time * 0.35 + b.id); ctx.scale(1, 0.36);
  const disk = ctx.createRadialGradient(0, 0, b.radius * 0.7, 0, 0, b.radius * 3.1);
  disk.addColorStop(0, "rgba(0,0,0,0)"); disk.addColorStop(0.28, "rgba(236,214,176,0.9)");
  disk.addColorStop(0.52, "rgba(176,92,48,0.32)"); disk.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = disk; ctx.beginPath(); ctx.arc(0, 0, b.radius * 3.1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 1.18, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,236,210,0.75)"; ctx.lineWidth = Math.max(1.1, 1.5 / zoom); ctx.stroke();
  ctx.fillStyle = "#050506"; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill();
}
function screenToWorld(cam, sx, sy, w, h) {
  return { x: cam.x + (sx - w / 2) / cam.zoom, y: cam.y + (sy - h / 2) / cam.zoom };
}

export {
  G, STEP, MAX_BODIES, FLING, ZOOM_MIN, ZOOM_MAX, PREDICT_STEPS, PREDICT_DT,
  PRESETS, radiusFor, createSim, createBody, stepSim, predictPath,
  seedSystem, seedFigureEight, drawStarfield, drawTrails, drawPlanet,
  drawStar, drawHole, rgba, screenToWorld, clamp
};
