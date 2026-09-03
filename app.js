import {
  STEP, MAX_BODIES, FLING, ZOOM_MIN, ZOOM_MAX, PREDICT_STEPS, PREDICT_DT,
  PRESETS, radiusFor, createSim, createBody, stepSim, predictPath,
  seedSystem, seedFigureEight, drawStarfield, drawTrails, drawPlanet,
  drawStar, drawHole, rgba, screenToWorld, clamp
} from "./sim.js";

let audio = null, muted = false;
function unlockAudio() {
  if (audio) { if (audio.ctx.state === "suspended") audio.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC({ latencyHint: "interactive" });
  const master = ctx.createGain(); master.gain.value = 0.65; master.connect(ctx.destination);
  audio = { ctx, master };
}
function beep(freq, dur, type, peak) {
  if (muted || !audio || audio.ctx.state !== "running") return;
  const { ctx, master } = audio;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur + 0.02);
}
function playLaunch(speed) { beep(180 + Math.min(400, speed * 0.4), 0.12, "sine", 0.08); }
function playMerge(mass) { beep(90 + Math.min(200, mass * 0.08), 0.18, "triangle", 0.12); }

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d", { alpha: false });
let sim = seedSystem();
const cam = { x: 0, y: 0, zoom: 1 };
const settings = { preset: "planet", timeScale: 1, paused: false, trails: true };
const pointers = new Map();
let drag = null, path = null, size = { w: 1, h: 1, dpr: 1 };
let acc = 0, last = performance.now();

const ICONS = {
  moon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>',
  planet: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="7"/><path d="M3 12h18"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  hole: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
};
const presetsEl = document.getElementById("presets");
for (const id of ["moon", "planet", "star", "hole"]) {
  const b = document.createElement("button");
  b.dataset.id = id; b.innerHTML = `${ICONS[id]}<span>${PRESETS[id].label}</span>`;
  b.setAttribute("aria-pressed", id === "planet" ? "true" : "false");
  b.addEventListener("click", () => {
    settings.preset = id;
    for (const el of presetsEl.children) el.setAttribute("aria-pressed", el.dataset.id === id ? "true" : "false");
  });
  presetsEl.appendChild(b);
}
function setCount() {
  const n = sim.bodies.length;
  const t = n + (n === 1 ? " body" : " bodies");
  document.getElementById("count").textContent = t;
  document.getElementById("count-m").textContent = t;
  document.getElementById("count").classList.toggle("cap", n >= MAX_BODIES);
  document.getElementById("hint").textContent = n === 0
    ? "Drag to fling a body. Place a star first if you want an orbit."
    : "Drag to fling · Two-finger pan · Scroll to zoom";
}
setCount();
const scale = document.getElementById("scale");
const setScaleLabel = (v) => {
  const t = `${v}×`;
  document.getElementById("scale-l").textContent = t;
  document.getElementById("scale-r").textContent = t;
};
scale.addEventListener("input", () => { settings.timeScale = Number(scale.value); setScaleLabel(settings.timeScale); });
const pauseBtn = document.getElementById("pause");
pauseBtn.addEventListener("click", () => {
  settings.paused = !settings.paused;
  pauseBtn.setAttribute("aria-pressed", settings.paused ? "true" : "false");
  pauseBtn.innerHTML = settings.paused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
});
const trailsBtn = document.getElementById("trails");
trailsBtn.addEventListener("click", () => {
  settings.trails = !settings.trails;
  trailsBtn.setAttribute("aria-pressed", settings.trails ? "true" : "false");
});
document.getElementById("eight").addEventListener("click", () => { sim = seedFigureEight(); cam.x = 0; cam.y = 0; cam.zoom = 1.15; path = null; setCount(); });
document.getElementById("reset").addEventListener("click", () => { sim = seedSystem(); cam.x = 0; cam.y = 0; cam.zoom = 1; path = null; setCount(); });
document.getElementById("clear").addEventListener("click", () => { sim = createSim(); cam.x = 0; cam.y = 0; cam.zoom = 1; path = null; setCount(); });

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  size = { w: rect.width, h: rect.height, dpr };
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
}
resize();
new ResizeObserver(resize).observe(canvas);

function clientXY(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
canvas.addEventListener("pointerdown", (e) => {
  unlockAudio();
  canvas.setPointerCapture(e.pointerId);
  const p = clientXY(e);
  pointers.set(e.pointerId, p);
  if (pointers.size >= 2) {
    const pts = [...pointers.values()];
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    drag = { mode: "pinch", dist: Math.hypot(dx, dy) };
    path = null;
    return;
  }
  if (e.button === 1 || e.shiftKey || e.spaceKey) {
    drag = { mode: "pan", id: e.pointerId, lx: p.x, ly: p.y };
    return;
  }
  const w = screenToWorld(cam, p.x, p.y, size.w, size.h);
  drag = { mode: "fling", id: e.pointerId, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = clientXY(e);
  pointers.set(e.pointerId, p);
  if (drag?.mode === "pinch" && pointers.size >= 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    if (drag.dist > 1) cam.zoom = clamp(cam.zoom * (dist / drag.dist), ZOOM_MIN, ZOOM_MAX);
    drag.dist = dist;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    if (drag.lx != null) {
      cam.x -= (mid.x - drag.lx) / cam.zoom;
      cam.y -= (mid.y - drag.ly) / cam.zoom;
    }
    drag.lx = mid.x; drag.ly = mid.y;
    return;
  }
  if (drag?.mode === "pan") {
    cam.x -= (p.x - drag.lx) / cam.zoom;
    cam.y -= (p.y - drag.ly) / cam.zoom;
    drag.lx = p.x; drag.ly = p.y;
    return;
  }
  if (drag?.mode === "fling") {
    const w = screenToWorld(cam, p.x, p.y, size.w, size.h);
    drag.x1 = w.x; drag.y1 = w.y;
    const def = PRESETS[settings.preset];
    path = predictPath(sim, {
      kind: def.kind, mass: def.mass, x: drag.x0, y: drag.y0,
      vx: (drag.x1 - drag.x0) * FLING, vy: (drag.y1 - drag.y0) * FLING,
      color: def.color, glow: def.glow,
    }, PREDICT_STEPS, PREDICT_DT);
  }
});
function endPointer(e) {
  const was = drag;
  pointers.delete(e.pointerId);
  if (was?.mode === "fling" && was.id === e.pointerId) {
    if (sim.bodies.length < MAX_BODIES) {
      const def = PRESETS[settings.preset];
      const vx = (was.x1 - was.x0) * FLING, vy = (was.y1 - was.y0) * FLING;
      sim.bodies.push(createBody(sim, def.kind, def.mass, was.x0, was.y0, vx, vy));
      playLaunch(Math.hypot(vx, vy));
      setCount();
    }
    path = null;
  }
  if (pointers.size < 2 && drag?.mode === "pinch") drag = null;
  if (pointers.size === 0) drag = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = clientXY(e);
  const before = screenToWorld(cam, p.x, p.y, size.w, size.h);
  cam.zoom = clamp(cam.zoom * (e.deltaY > 0 ? 0.9 : 1.11), ZOOM_MIN, ZOOM_MAX);
  const after = screenToWorld(cam, p.x, p.y, size.w, size.h);
  cam.x += before.x - after.x; cam.y += before.y - after.y;
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") { e.preventDefault(); pauseBtn.click(); }
  if (e.key === "1") document.querySelector('[data-id="moon"]').click();
  if (e.key === "2") document.querySelector('[data-id="planet"]').click();
  if (e.key === "3") document.querySelector('[data-id="star"]').click();
  if (e.key === "4") document.querySelector('[data-id="hole"]').click();
});

function render(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!settings.paused) {
    acc += dt * settings.timeScale;
    acc = Math.min(acc, 0.28);
    let steps = 0;
    while (acc >= STEP && steps < 16) {
      stepSim(sim, STEP, true);
      for (const m of sim.merges) playMerge(m.mass);
      acc -= STEP; steps += 1;
    }
  }
  const { w, h, dpr } = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#07080b";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  drawStarfield(ctx, cam, w, h);
  if (settings.trails) drawTrails(ctx, sim.bodies, cam.zoom);
  if (path && path.length >= 4) {
    ctx.beginPath();
    ctx.setLineDash([6 / cam.zoom, 8 / cam.zoom]);
    ctx.strokeStyle = "rgba(232,233,237,0.45)";
    ctx.lineWidth = 1.4 / cam.zoom;
    ctx.moveTo(path[0], path[1]);
    for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
    ctx.stroke(); ctx.setLineDash([]);
  }
  const time = now / 1000;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const b of sim.bodies) {
    if (b.kind === "hole") continue;
    const scaleG = b.kind === "star" ? 2.1 : 1.7;
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.radius * scaleG);
    g.addColorStop(0, rgba(b.glow, b.kind === "star" ? 0.16 : 0.14));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * scaleG, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  for (const b of sim.bodies) {
    if (b.kind === "star") drawStar(ctx, b, time);
    else if (b.kind === "hole") drawHole(ctx, b, time, cam.zoom);
    else drawPlanet(ctx, b, sim.bodies);
  }
  if (drag?.mode === "fling") {
    const def = PRESETS[settings.preset];
    ctx.beginPath();
    ctx.arc(drag.x0, drag.y0, radiusFor(def.kind, def.mass), 0, Math.PI * 2);
    ctx.strokeStyle = rgba(def.glow, 0.85); ctx.lineWidth = 1.6 / cam.zoom; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(drag.x0, drag.y0); ctx.lineTo(drag.x1, drag.y1);
    ctx.strokeStyle = "rgba(232,233,237,0.55)"; ctx.stroke();
  }
  ctx.restore();
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
