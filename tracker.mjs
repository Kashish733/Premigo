// Keeps field boxes glued to the page while the phone moves. Between model reads (a few seconds apart) we compare
// each new camera frame with the frame the boxes were placed on, estimate how the picture shifted/zoomed, and move
// the boxes the same way. Pure JS on small grayscale thumbnails: ~20 ms per frame, no native dependencies.
// It handles pan and zoom. Rotation/tilt is corrected when the model re-locates the fields (see agent.mjs).
import sharp from 'sharp';

export const TW = 128, TH = 72; // thumbnail size
const SCALES = [0.9, 0.95, 1, 1.05, 1.1];
const TILTS = [-12, -8, -4, -2, 2, 4, 8, 12]; // degrees (coarse; refined afterwards)
const RX = 12, RY = 8; // search range in thumbnail pixels (about +-9% of the picture)
const STEP = 2; // sample every 2nd pixel
const LOST_ERR = 0.85; // mean difference of the contrast-normalised edge maps (two unrelated views score about 1.1; a good match 0.1-0.4)

/** @param {{ raw: Uint8Array, width: number, height: number }} img RGBA pixels */
export async function makeThumb(img) {
  const data = await sharp(img.raw, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(TW, TH, { fit: 'fill' }).greyscale().blur(0.8).raw().toBuffer();
  // Matching uses the printed structure (edges) scaled to unit contrast, NOT raw brightness: a dimmer room, a shadow or
  // auto-exposure must not look like the page moved.
  const hp = highPass(data);
  let sq = 0, cnt = 0;
  for (let y = 2; y < TH - 2; y++) for (let x = 2; x < TW - 2; x++) { sq += hp[y * TW + x] ** 2; cnt++; }
  const k = 1 / (Math.sqrt(sq / cnt) + 1.5);
  for (let i = 0; i < hp.length; i++) hp[i] *= k;
  return { data, hp, aspect: img.width / img.height };
}

// Mean gray-level difference when ref point p lands at p' = c + s * R(th) * (p - c) + d. Rotation is done in
// aspect-corrected units so it is a true rotation of the picture, not a skew. th in radians, clockwise on screen.
function evalT(a, b, A, s, th, dxn, dyn) {
  const cs = Math.cos(th), sn = Math.sin(th);
  let sum = 0, n = 0;
  for (let gy = 4; gy < TH - 4; gy += STEP) {
    const ya = (gy + 0.5) / TH - 0.5;
    for (let gx = 4; gx < TW - 4; gx += STEP) {
      const xa = ((gx + 0.5) / TW - 0.5) * A;
      const u2 = 0.5 + (s * (xa * cs - ya * sn)) / A + dxn;
      const v2 = 0.5 + s * (xa * sn + ya * cs) + dyn;
      const x2 = Math.floor(u2 * TW), y2 = Math.floor(v2 * TH);
      if (x2 < 0 || x2 >= TW || y2 < 0 || y2 >= TH) continue;
      sum += Math.abs(a[gy * TW + gx] - b[y2 * TW + x2]);
      n++;
    }
  }
  return n < 700 ? Infinity : sum / n; // too little overlap to judge
}

/**
 * Best transform mapping points of `ref` onto `cur`: shift (dx, dy), zoom s and tilt th (radians).
 * Stage 1 searches shift + zoom with no tilt; stage 2 tries tilts around that answer (cheap local search).
 * @returns {{ s: number, dx: number, dy: number, th: number, err: number }}
 */
export function estimate(ref, cur, prior = null) {
  const a = ref.hp, b = cur.hp, A = ref.aspect;
  let best = { s: 1, dx: 0, dy: 0, th: 0, err: Infinity, score: Infinity };
  const consider = (s, th, tx, ty) => {
    const err = evalT(a, b, A, s, th, tx / TW, ty / TH);
    // prefer small, stable moves
    const score = err + 0.003 * (Math.abs(tx) + Math.abs(ty)) + 0.6 * Math.abs(s - 1) + 0.4 * Math.abs(th);
    if (score < best.score) best = { s, dx: tx / TW, dy: ty / TH, th, err, score };
  };
  if (prior) { // quick mode: the picture moves a little between frames, so look only around the last answer
    const txp = Math.round(prior.dx * TW), typ = Math.round(prior.dy * TH);
    for (const ds of [-0.02, 0, 0.02]) for (const dDeg of [-2, -1, 0, 1, 2]) {
      for (let ty = typ - 2; ty <= typ + 2; ty++) for (let tx = txp - 2; tx <= txp + 2; tx++) consider(prior.s + ds, prior.th + (dDeg * Math.PI) / 180, tx, ty);
    }
    return best;
  }
  for (const s of SCALES) for (let ty = -RY; ty <= RY; ty++) for (let tx = -RX; tx <= RX; tx++) consider(s, 0, tx, ty);
  const flat = best; // best with no tilt
  // Stage 2: coarse tilts, searching around the flat answer AND around "no shift" (a tilted picture can fool stage 1)
  const centers = [[Math.round(flat.dx * TW), Math.round(flat.dy * TH)]];
  if (centers[0][0] !== 0 || centers[0][1] !== 0) centers.push([0, 0]);
  for (const deg of TILTS) {
    for (const [cx, cy] of centers) {
      for (let ty = cy - 4; ty <= cy + 4; ty++) for (let tx = cx - 4; tx <= cx + 4; tx++) consider(flat.s, (deg * Math.PI) / 180, tx, ty);
    }
  }
  if (best.th !== 0) { // Stage 3: refine tilt, zoom and shift around the best coarse answer
    const { th: th0, s: s0, dx: dx0, dy: dy0 } = best;
    const txb = Math.round(dx0 * TW), tyb = Math.round(dy0 * TH);
    for (const dDeg of [-1.5, -0.75, 0.75, 1.5]) {
      for (const ds of [-0.025, 0, 0.025]) {
        for (let ty = tyb - 2; ty <= tyb + 2; ty++) for (let tx = txb - 2; tx <= txb + 2; tx++) consider(s0 + ds, th0 + (dDeg * Math.PI) / 180, tx, ty);
      }
    }
  }
  if (best.th !== 0 && best.err > flat.err * 0.93) best = flat; // tilt must clearly beat "no tilt", or it is just noise
  return best;
}

/** Move a box with the page: its centre follows the transform, its size follows the zoom. */
/** Edge-only copy of a thumbnail (pixel minus its 5x5 neighbourhood mean): lighting changes drop out, printed structure stays. */
function highPass(data) {
  const out = new Float32Array(TW * TH);
  for (let y = 2; y < TH - 2; y++) for (let x = 2; x < TW - 2; x++) {
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += data[(y + dy) * TW + x + dx];
    out[y * TW + x] = data[y * TW + x] - s / 25;
  }
  return out;
}

/**
 * How similar is the printed content of two views once aligned by transform t? 1 = same content, ~0 = different content.
 * Normalised cross-correlation of the edge maps, so a darker photo or a brighter room does not count as "different".
 */
function contentSimilarity(refHP, curHP, A, t) {
  const cs = Math.cos(t.th), sn = Math.sin(t.th);
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let gy = 4; gy < TH - 4; gy++) {
    const ya = (gy + 0.5) / TH - 0.5;
    for (let gx = 4; gx < TW - 4; gx++) {
      const xa = ((gx + 0.5) / TW - 0.5) * A;
      const x2 = Math.floor((0.5 + (t.s * (xa * cs - ya * sn)) / A + t.dx) * TW), y2 = Math.floor((0.5 + t.s * (xa * sn + ya * cs) + t.dy) * TH);
      if (x2 < 2 || x2 >= TW - 2 || y2 < 2 || y2 >= TH - 2) continue;
      const a = refHP[gy * TW + gx], b = curHP[y2 * TW + x2];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
    }
  }
  if (n < 700) return 0;
  const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : 0;
}

export function applyToBox([x, y, w, h], t, A) {
  const cs = Math.cos(t.th), sn = Math.sin(t.th);
  const xa = (x + w / 2 - 0.5) * A, ya = y + h / 2 - 0.5;
  const cx = 0.5 + (t.s * (xa * cs - ya * sn)) / A + t.dx, cy = 0.5 + t.s * (xa * sn + ya * cs) + t.dy;
  return [cx - (w * t.s) / 2, cy - (h * t.s) / 2, w * t.s, h * t.s];
}

export class FieldTracker {
  constructor() { this.frames = 0; this.m = null; this.ref = null; this.boxes = null; this.t = { s: 1, dx: 0, dy: 0, th: 0 }; this.err = 0; }
  get ready() { return !!this.ref; }

  /** Boxes are fractions of the picture in `img`. Call right after reading the page. */
  async setReference(img, boxes) {
    this.ref = await makeThumb(img);
    this.similarity = 1; // 1 = the camera still shows the same content as when the boxes were placed
    this.boxes = boxes;
    this.t = { s: 1, dx: 0, dy: 0, th: 0 };
    this.err = 0;
    this.frames = 0;
    this.m = null;
  }

  /**
   * Where the boxes are in the current picture.
   * @returns {{ boxes: Record<string, number[]> | null, lost: boolean, err: number }} lost = different picture shape or a bad match
   */
  async update(img) {
    if (!this.ref) return { boxes: null, lost: true, err: Infinity };
    const aspect = img.width / img.height;
    if (Math.abs(aspect / this.ref.aspect - 1) > 0.06) return { boxes: null, lost: true, err: Infinity }; // camera turned
    const cur = await makeThumb(img);
    const quick = this.m && this.frames++ % 20 !== 0 && this.err < LOST_ERR * 0.6;
    let m = estimate(this.ref, cur, quick ? this.m : null);
    if (quick && m.err > this.err * 1.5 + 0.25) m = estimate(this.ref, cur); // the quick guess went bad: search everything
    this.m = m;
    const k = 0.7; // smoothing: less jitter, still quick
    this.t = { s: this.t.s + k * (m.s - this.t.s), dx: this.t.dx + k * (m.dx - this.t.dx), dy: this.t.dy + k * (m.dy - this.t.dy), th: this.t.th + k * (m.th - this.t.th) };
    this.err = m.err;
    this.similarity = contentSimilarity(this.ref.hp, cur.hp, this.ref.aspect, this.t);
    const boxes = {};
    for (const [id, box] of Object.entries(this.boxes)) boxes[id] = applyToBox(box, this.t, this.ref.aspect);
    return { boxes, lost: m.err > LOST_ERR, err: m.err, similarity: this.similarity };
  }
}
