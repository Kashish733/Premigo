// Offline test of the motion tracker: shift, zoom and tilt a page by KNOWN amounts and see how well boxes follow.
// Run: node test-tracker.mjs   (no API keys needed)
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { FieldTracker } from './tracker.mjs';
import { annotateToPng } from './annotate.mjs';

const W = 960, H = 540;
const base = readFileSync('forms/permiso.png');
const doc = JSON.parse(readFileSync('forms/permiso.json', 'utf8'));
const rgba = async png => { const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { raw: data, width: info.width, height: info.height }; };
const boxes0 = Object.fromEntries(doc.fields.map(f => [f.id, f.bbox]));

// Scale about the centre by s, then move by (dx, dy) picture fractions. Ground truth: p' = c + s(p - c) + d.
async function transformed(s, dx, dy) {
  const w = Math.round(W * s), h = Math.round(H * s);
  const scaled = await sharp(base).resize(w, h).png().toBuffer();
  const left = Math.round((W - w) / 2 + dx * W), top = Math.round((H - h) / 2 + dy * H);
  const sx = Math.max(0, -left), sy = Math.max(0, -top);
  const cw = Math.min(w - sx, W - Math.max(0, left)), ch = Math.min(h - sy, H - Math.max(0, top));
  const piece = await sharp(scaled).extract({ left: sx, top: sy, width: cw, height: ch }).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 3, background: '#9ca3af' } })
    .composite([{ input: piece, left: Math.max(0, left), top: Math.max(0, top) }]).png().toBuffer();
}
async function tilted(deg) { // rotate about the centre (clockwise), keep the same frame size
  const r = await sharp(base).rotate(deg, { background: '#9ca3af' }).png().toBuffer();
  const m = await sharp(r).metadata();
  return sharp(r).extract({ left: Math.round((m.width - W) / 2), top: Math.round((m.height - H) / 2), width: W, height: H }).png().toBuffer();
}
// Where a ground-truth box should be after the camera moved: for tilt, rotate the 4 corners and take the bounding box.
const truthMove = (b, s, dx, dy) => [0.5 + s * (b[0] - 0.5) + dx, 0.5 + s * (b[1] - 0.5) + dy, b[2] * s, b[3] * s];
function truthTilt(b, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a);
  const pts = [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0], b[1] + b[3]], [b[0] + b[2], b[1] + b[3]]].map(([u, v]) => {
    const x = (u - 0.5) * W, y = (v - 0.5) * H; // pixels from centre
    return [(x * c - y * si) / W + 0.5, (x * si + y * c) / H + 0.5]; // clockwise on screen
  });
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

const cases = [
  { name: 'pan right 5%, down 3%', img: () => transformed(1, 0.05, 0.03), truth: b => truthMove(b, 1, 0.05, 0.03) },
  { name: 'pan left 8%', img: () => transformed(1, -0.08, 0), truth: b => truthMove(b, 1, -0.08, 0) },
  { name: 'move closer (zoom 1.1x)', img: () => transformed(1.1, 0, 0), truth: b => truthMove(b, 1.1, 0, 0) },
  { name: 'move away (zoom 0.92x)', img: () => transformed(0.92, 0, 0), truth: b => truthMove(b, 0.92, 0, 0) },
  { name: 'zoom 1.05x + pan', img: () => transformed(1.05, 0.04, -0.03), truth: b => truthMove(b, 1.05, 0.04, -0.03) },
  { name: 'tilt 4 deg', img: () => tilted(4), truth: b => truthTilt(b, 4) },
  { name: 'tilt 10 deg', img: () => tilted(10), truth: b => truthTilt(b, 10) },
];

const tracker = new FieldTracker();
const ref = await rgba(base);
for (const c of cases) {
  await tracker.setReference(ref, boxes0);
  const png = await c.img();
  const t0 = Date.now();
  let r;
  for (let i = 0; i < 4; i++) r = await tracker.update(await rgba(png)); // a few frames, like a live stream (smoothing settles)
  const ms = (Date.now() - t0) / 4;
  const errs = Object.entries(r.boxes).map(([id, b]) => { const t = c.truth(boxes0[id]); return Math.hypot((b[0] + b[2] / 2 - t[0] - t[2] / 2) * W, (b[1] + b[3] / 2 - t[1] - t[3] / 2) * H); });
  const mean = errs.reduce((x, y) => x + y, 0) / errs.length, max = Math.max(...errs);
  console.log(`${c.name.padEnd(26)} centre error: mean ${mean.toFixed(1)} px, max ${max.toFixed(1)} px (of 960)  match err ${r.err.toFixed(1)}  lost=${r.lost}  ${ms.toFixed(0)} ms/frame`);
  if (c.name.startsWith('zoom 1.05x') || c.name === 'tilt 10 deg') {
    const f = doc.fields.map(f => ({ ...f, bbox: r.boxes[f.id] }));
    writeFileSync(`out/track-${c.name.replace(/[^a-z0-9]+/gi, '-')}.png`, await annotateToPng(png, { fields: f }, { showAll: true, lang: 'en', banner: c.name }));
  }
}
