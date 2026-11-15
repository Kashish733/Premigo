// Frame quality gate + "read this page" call to Claude. Output is a DocState the voice agent can
// talk about and the annotator can draw from.
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

const MODEL = process.env.VISION_MODEL || 'claude-sonnet-5-5';
// Smaller images read faster. 768 keeps handwriting legible on a 640x360 phone frame; raise it for dense forms.
const VISION_WIDTH = Number(process.env.VISION_WIDTH) || 768; // mistake checks
const READ_WIDTH = Number(process.env.READ_WIDTH) || 1600; // full page read: small print needs pixels

/** Laplacian variance of a grayscale downscale: low = blurry / moving. Roughly: < 40 blurry. */
export async function sharpness(image) {
  const { data, info } = await sharp(image).resize(320).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      sum += v; sumSq += v * v; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

const SYSTEM = `You help people who do not read the language of a paper form or notice. You see one camera photo of a page.
Reply with ONLY a JSON object, no prose, in this shape:
{
  "doc_type": "short name, e.g. school permission slip",
  "language": "language the page is written in (en or es)",
  "summary_en": "2-3 plain sentences: what this is and what the reader must do",
  "summary_es": "same in simple Spanish",
  "deadlines": [{"text_en": "...", "text_es": "...", "date": "YYYY-MM-DD or null"}],
  "fields": [{
    "id": "snake_case_id",
    "label_en": "field label in English",
    "label_es": "field label in Spanish",
    "hint_en": "what to write there, one short sentence",
    "hint_es": "same in Spanish",
    "bbox": [x, y, w, h],
    "filled": false,
    "value": null
  }]
}
bbox is the WRITING AREA of the field (blank line or box), as fractions 0..1 of the image width/height, [left, top, width, height].
If a field already has handwriting, set filled=true and value to what is written. Include checkboxes and signature lines.
If the page is unreadable or no page is visible, return {"doc_type":"none","fields":[]}.`;

const FINE_SCHEMA = "  \"heads_up\": [{\n    \"kind\": \"bring | deadline | cost | consent | rights | privacy | requirement | scam_risk | other\",\n    \"importance\": \"high | medium | low\",\n    \"original\": \"the small text as printed, shortened\",\n    \"plain_en\": \"what it means for the reader, plain words, one sentence\",\n    \"plain_es\": \"same in simple Spanish\",\n    \"action_en\": \"what the reader should do about it, or null\",\n    \"action_es\": \"same in Spanish, or null\"\n  }],\n  \"scam_check\": {\n    \"risk\": \"none | low | medium | high\",\n    \"signs_en\": [\"short sign you noticed\"], \"signs_es\": [\"same in Spanish\"],\n    \"advice_en\": \"one sentence on what to do\", \"advice_es\": \"same in Spanish\"\n  },\n  \"small_print_illegible\": false,\n";
const FINE_RULES = "READ ALL TEXT, including tiny footnotes, footers, headers, margins, stamps and fine print. Do not skip the small lines at the end.\nAdd a heads_up entry for every small note that tells the reader something to bring, pay, do by a date, agree to, give up or beware of.\nExamples: \"Bring your ID and insurance card to the first visit\" (kind bring), a fee or \"non-refundable\" (cost), permission to use photos or share data\n(consent/privacy), waiving the right to sue or releasing liability (rights), automatic renewal or late penalties (cost), deadlines (deadline).\nPut the most important ones first. Use plain words a worried person with limited English can follow.\nscam_check: look for signs of a scam or phishing: payment by gift card, crypto, wire, Zelle/Cash App or cash to a person; threats or extreme urgency;\nrequests for SSN, bank login, passwords or full card numbers; unknown phone numbers or links to \"verify\"; prizes; an organization name that does not match;\nfees to release money or benefits. Use risk \"none\" when it looks like an ordinary school, clinic, work or government form. Only report signs you can see;\nword them as \"signs to double check\", never as a certain accusation.\nIf some text is too small or blurry to read, set small_print_illegible to true.\n";
/** Which provider reads pages: Claude if ANTHROPIC_API_KEY is set, otherwise Gemini (GOOGLE_API_KEY). */
export function visionProvider() {
  return process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.GOOGLE_API_KEY ? 'gemini' : null;
}

let client, genai;
/** @param {Buffer} image PNG/JPEG bytes */
export async function readDocument(image) {
  const jpeg = await sharp(image).resize({ width: VISION_WIDTH, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  if (visionProvider() === 'gemini') return readWithGemini(jpeg);
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: 'Read this page.' },
      ],
    }],
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return parseJson(text);
}

export function parseJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('vision: no JSON in model reply');
  const state = JSON.parse(text.slice(start, end + 1));
  state.fields = (state.fields ?? []).filter(f => Array.isArray(f.bbox) && f.bbox.length === 4 && f.bbox.every(Number.isFinite));
  // Some models answer on a 0..1000 grid instead of 0..1 fractions: normalize those.
  for (const f of state.fields) if (Math.max(...f.bbox) > 1.5) f.bbox = f.bbox.map(n => n / 1000);
  return state;
}

async function readWithGemini(jpeg) {
  const { GoogleGenAI } = await import('@google/genai');
  genai ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const res = await gen({
    model: process.env.VISION_MODEL || 'gemini-3.1-flash-lite',
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: 'Read this page.' }] }],
    config: {
      systemInstruction: SYSTEM, responseMimeType: 'application/json', temperature: 0.1,
      httpOptions: { timeout: 12000 }, // a live call cannot wait long
    },
  });
  return parseJson(res.text ?? '');
}

// ---------- Mistake detection ----------
const REVIEW_SYSTEM = `You check a paper form that a person is filling in by hand, seen in one camera photo.
You are given the form's fields (id, label, what belongs there). Look at the HANDWRITING and checkmarks only.
Reply with ONLY a JSON object:
{
  "fields": [{"id": "...", "filled": true|false, "value": "what is written, or null"}],
  "issues": [{"field_id": "...", "problem_en": "max 8 words", "problem_es": "max 8 words, simple Spanish"}]
}
Report an issue ONLY when you are quite sure, for one of these reasons:
- WRONG PLACE: handwriting belongs to a different field (for example a signature or name written on the date line, or a date written on the signature line).
- WRONG KIND: the value cannot be right for that field (a name in a phone field, letters where a date is needed).
- SKIPPED: a required field is empty while a LATER field on the page is already filled in.
- CONTRADICTION: two exclusive checkboxes are both marked.
Never report an issue for a field that is simply not filled yet when nothing after it is filled.
Never report spelling, style or handwriting quality. When unsure, report no issue. If no page is visible, return {"fields":[],"issues":[]}.
problem_* text is spoken to the person, so address the field: e.g. "That's the signature, not the date" / "Eso es la firma, no la fecha".`;

/**
 * Compare what is written on the page with what each field expects.
 * @param {Buffer} image PNG/JPEG bytes
 * @param {{ fields: object[] }} doc DocState from readDocument
 * @returns {Promise<{ fields: {id:string, filled:boolean, value:any}[], issues: {field_id:string, problem_en:string, problem_es:string}[] }>}
 */
export async function reviewDocument(image, doc) {
  const jpeg = await sharp(image).resize({ width: VISION_WIDTH, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const list = doc.fields.map(f => `- ${f.id}: ${f.label_en} (${f.hint_en ?? 'fill in'})`).join('\n');
  const text = `Fields, in page order:\n${list}\n\nCheck the handwriting on this page.`;
  let raw;
  if (visionProvider() === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    genai ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const res = await gen({
      model: process.env.VISION_MODEL || 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text }] }],
      config: { systemInstruction: REVIEW_SYSTEM, responseMimeType: 'application/json', temperature: 0, httpOptions: { timeout: 15000 } },
    });
    raw = res.text ?? '';
  } else {
    client ??= new Anthropic();
    const res = await client.messages.create({
      model: MODEL, max_tokens: 1200, system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }, { type: 'text', text }] }],
    });
    raw = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0) throw new Error('review: no JSON in model reply');
  const out = JSON.parse(raw.slice(start, end + 1));
  const ids = new Set(doc.fields.map(f => f.id));
  out.fields = (out.fields ?? []).filter(f => ids.has(f.id));
  out.issues = (out.issues ?? []).filter(i => ids.has(i.field_id) && i.problem_en && i.problem_es);
  return out;
}

// ---------- Reliability + change detection ----------
/** Gemini sometimes fails once and works on the next try: retry one time after a short pause. */
async function retry(fn) {
  try { return await fn(); } catch (err) {
    await new Promise(r => setTimeout(r, 400));
    return fn();
  }
}
function gen(args) { return retry(() => genai.models.generateContent(args)); }

/** 64-bit average hash of a page photo, as a 64-char bit string. Similar pictures give similar hashes. */
export async function pageHash(image) {
  const px = await sharp(image).resize(8, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  const avg = px.reduce((a, b) => a + b, 0) / px.length;
  return Array.from(px, v => (v > avg ? '1' : '0')).join('');
}
/** Number of differing bits (0..64). Hand movement or a pen changes a few; a different page changes many. */
export function hashDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// ---------- Fine print, "don't miss this" notes and scam check (separate, parallel call) ----------
const FINE_SYSTEM = `You help people who do not read the language of a paper form or notice. You see one camera photo of a page.
Your job is ONLY the small print and the warnings, not the form fields. Reply with ONLY a JSON object:
{
${FINE_SCHEMA}}
${FINE_RULES}If no page is visible, return {"heads_up":[],"scam_check":{"risk":"none"},"small_print_illegible":false}.`;

/** Reads footers, footnotes and warnings at high resolution. Returns { heads_up, scam_check, small_print_illegible }. */
export async function readFinePrint(image) {
  const jpeg = await sharp(image).resize({ width: READ_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const out = await askJson(FINE_SYSTEM, jpeg, 'Read the small print and warnings on this page.', 40000, 3000);
  out.heads_up = (out.heads_up ?? []).filter(h => h.plain_en && h.plain_es);
  out.scam_check ??= { risk: 'none' };
  return out;
}

/** Ask the configured vision model for a JSON answer about one image. */
async function askJson(system, jpeg, text, timeoutMs = 25000, maxTokens = 2500) {
  let raw;
  if (visionProvider() === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    genai ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const res = await gen({
      model: process.env.VISION_MODEL || 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text }] }],
      config: { systemInstruction: system, responseMimeType: 'application/json', temperature: 0, httpOptions: { timeout: timeoutMs } },
    });
    raw = res.text ?? '';
  } else {
    client ??= new Anthropic();
    const res = await client.messages.create({
      model: MODEL, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }, { type: 'text', text }] }],
    });
    raw = res.content.filter(x => x.type === 'text').map(x => x.text).join('');
  }
  const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
  if (i < 0) throw new Error('vision: no JSON in model reply');
  return JSON.parse(raw.slice(i, j + 1));
}

/** Load the vision client and image code ahead of the first page, so the first read is not slower than the rest. */
export async function warmVision() {
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  if (visionProvider() === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    genai ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  } else if (visionProvider() === 'claude') {
    client ??= new Anthropic();
  }
}

/**
 * The model's boxes are close but rarely exact, and a writing line is thin, so a small error looks like a misalignment.
 * Fix it with the picture itself: for each wide, thin box look for the dark printed line near its bottom edge (allowing
 * a slight tilt) and sit the box on that line. Boxes with no clear line nearby (checkboxes) keep the model's position.
 * Changes field.bbox in place. @returns {Promise<number>} how many boxes were moved
 */
export async function snapBoxes(image, fields) {
  const { data, info } = await sharp(image).resize({ width: 800, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const TILTS = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8].map(d => Math.tan((d * Math.PI) / 180)); // flat first: it wins ties
  let moved = 0;
  for (const f of fields) {
    const [x, y, bw, bh] = f.bbox;
    if (bw < 0.12 || bh > 0.09) continue; // only wide, thin boxes look like a writing line
    const x0 = Math.max(0, Math.floor((x + bw * 0.1) * w)), x1 = Math.min(w - 1, Math.ceil((x + bw * 0.9) * w)); // inner 80%: ignore ragged ends
    if (x1 - x0 < 12) continue;
    const xm = (x0 + x1) / 2;
    const yb = y + bh; // the line sits at the bottom of the writing area
    const r0 = Math.max(0, Math.floor((yb - 0.05) * h)), r1 = Math.min(h - 1, Math.ceil((yb + 0.05) * h));
    // paper brightness near the box = median of the window; "ink" = clearly darker than that
    const sample = [];
    for (let r = r0; r <= r1; r += 2) for (let c = x0; c <= x1; c += 4) sample.push(data[r * w + c]);
    sample.sort((p, q) => p - q);
    const ink = sample[Math.floor(sample.length / 2)] - 55;
    // fraction of ink pixels along the line that passes through row r at the box centre with slope t
    const score = (r, t) => {
      let dark = 0, n = 0;
      for (let c = x0; c <= x1; c++) {
        const yy = Math.round(r + (c - xm) * t);
        if (yy < 0 || yy >= h) continue;
        n++;
        if (data[yy * w + c] < ink) dark++;
      }
      return n ? dark / n : 0;
    };
    let best = { r: -1, t: 0, s: 0 };
    for (const t of TILTS) for (let r = r0; r <= r1; r++) { const s = score(r, t); if (s > best.s + 0.02) best = { r, t, s }; } // +0.02: prefer flat unless tilt is clearly better
    if (best.r < 0 || best.s < 0.55) continue; // no clear line: keep the model's box
    let top = best.r, bot = best.r; // a thick line spans several rows: aim at the middle of the dark band
    while (top > r0 && score(top - 1, best.t) > best.s * 0.6) top--;
    while (bot < r1 && score(bot + 1, best.t) > best.s * 0.6) bot++;
    const lineY = (top + bot + 1) / 2 / h;
    const newH = Math.max(bh, 0.03);
    const next = [x, lineY - newH + 0.004, bw, newH];
    if (Math.abs(next[1] - y) > 0.002) moved++;
    f.bbox = next;
  }
  return moved;
}

/**
 * Page-level alignment. Detect every printed line on the page (allowing the page to be tilted), then match the model's
 * boxes to those lines. This fixes two things per-box snapping cannot: the model's boxes drifting further off the lower
 * they are on the page (a scale error), and the page tilt (boxes get an `angle` so they can be drawn tilted too).
 * Changes field.bbox / field.angle (degrees, clockwise) in place.
 * @returns {Promise<{ matched: number, total: number, tilt: number }>} matched < 2 means "could not align": use snapBoxes
 */
export async function alignBoxes(image, fields) {
  const { data, info } = await sharp(image).resize({ width: 800, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  // 1. ink: clearly darker than the rows 4 px above and below (thin printed lines, pen strokes, text strokes)
  const ink = new Uint8Array(w * h);
  for (let r = 4; r < h - 4; r++) for (let c = 0; c < w; c++) {
    const bg = (data[(r - 4) * w + c] + data[(r + 4) * w + c]) / 2;
    if (data[r * w + c] < bg - 28) ink[r * w + c] = 1;
  }
  // 2. long runs of ink along slightly tilted rows = printed lines
  const SLOPES = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8, -10, 10].map(d => ({ d, t: Math.tan((d * Math.PI) / 180) }));
  const minLen = Math.round(0.1 * w), GAP = 3;
  const runs = [];
  for (const { d, t } of SLOPES) {
    for (let r0 = 0; r0 < h; r0++) {
      let start = -1, last = -1;
      const flush = () => { if (start >= 0 && last - start + 1 >= minLen) runs.push({ r0, t, d, x0: start, x1: last, len: last - start + 1 }); start = -1; };
      for (let c = 0; c < w; c++) {
        const rr = Math.round(r0 + (c - w / 2) * t);
        if (rr >= 0 && rr < h && ink[rr * w + c]) { if (start < 0) start = c; last = c; }
        else if (start >= 0 && c - last > GAP) flush();
      }
      flush();
    }
  }
  const yAt = (L, x) => L.r0 + (x - w / 2) * L.t;
  runs.sort((p, q) => q.len - p.len || Math.abs(p.d) - Math.abs(q.d));
  const lines = [];
  for (const run of runs) { // keep the longest; drop copies (same line seen at other rows/tilts)
    const xc = (run.x0 + run.x1) / 2;
    const dup = lines.some(L => {
      const ov = Math.min(L.x1, run.x1) - Math.max(L.x0, run.x0);
      return ov > 0.5 * Math.min(L.len, run.len) && Math.abs(yAt(L, xc) - yAt(run, xc)) < 6;
    });
    if (!dup) lines.push(run);
  }
  // page tilt = length-weighted median tilt of the lines
  let tilt = 0;
  if (lines.length) {
    const sorted = [...lines].sort((p, q) => p.d - q.d); const half = sorted.reduce((s, L) => s + L.len, 0) / 2;
    let acc = 0; for (const L of sorted) { acc += L.len; if (acc >= half) { tilt = L.d; break; } }
  }
  // 3. how far off are the model's boxes? Match each wide box to its nearest line, then fit offset = a + k * y.
  const info2 = fields.map(f => {
    const [x, y, bw, bh] = f.bbox;
    return { f, x0: x * w, x1: (x + bw) * w, by: (y + bh) * h, bh, bw, wide: bw >= 0.12 && bh <= 0.09 };
  });
  const near = (b, by) => lines
    .filter(L => Math.min(L.x1, b.x1) - Math.max(L.x0, b.x0) >= 0.4 * (b.x1 - b.x0))
    .map(L => ({ L, y: yAt(L, (b.x0 + b.x1) / 2) }))
    .sort((p, q) => Math.abs(p.y - by) - Math.abs(q.y - by));
  const pairs = [];
  for (const b of info2) if (b.wide) { const n = near(b, b.by)[0]; if (n && Math.abs(n.y - b.by) <= 0.1 * h) pairs.push({ y: b.by, d: n.y - b.by }); }
  if (pairs.length < 2) return { matched: 0, total: info2.filter(b => b.wide).length, tilt };
  const fit = ps => { // least squares d = a + k * y
    const n = ps.length, sx = ps.reduce((s, p) => s + p.y, 0), sy = ps.reduce((s, p) => s + p.d, 0);
    const sxx = ps.reduce((s, p) => s + p.y * p.y, 0), sxy = ps.reduce((s, p) => s + p.y * p.d, 0);
    const den = n * sxx - sx * sx;
    const k = Math.abs(den) < 1e-6 ? 0 : (n * sxy - sx * sy) / den;
    return { a: (sy - k * sx) / n, k };
  };
  let m = fit(pairs);
  const resid = pairs.map(p => Math.abs(p.d - (m.a + m.k * p.y)));
  const cut = Math.max(0.02 * h, [...resid].sort((p, q) => p - q)[Math.floor(resid.length / 2)] * 2.5);
  const kept = pairs.filter((p, i) => resid[i] <= cut);
  if (kept.length >= 2) m = fit(kept);
  if (kept.length < 3) m.k = 0; // two points cannot tell a scale error from a shift: use the shift only
  const corrected = b => b.by + m.a + m.k * b.by;
  // 4. one-to-one match on the corrected positions, then sit each box on its line
  const used = new Set();
  const order = info2.filter(b => b.wide).sort((p, q) => corrected(p) - corrected(q));
  let matched = 0;
  const tol = 0.04 * h;
  for (const b of order) {
    const cb = corrected(b);
    const cand = near(b, cb).find(n => !used.has(n.L) && Math.abs(n.y - cb) <= tol);
    const newH = Math.max(b.bh, 0.03);
    if (cand) {
      used.add(cand.L); matched++;
      const x0 = Math.max(b.x0, cand.L.x0), x1 = Math.min(b.x1, cand.L.x1);
      const [nx0, nx1] = x1 - x0 >= 0.5 * (b.x1 - b.x0) ? [x0, x1] : [b.x0, b.x1]; // trust the printed line's ends if they agree
      b.f.bbox = [nx0 / w, cand.y / h - newH + 0.004, (nx1 - nx0) / w, newH];
      b.f.uncertain = false;
    } else {
      b.f.bbox = [b.x0 / w, cb / h - b.bh, b.bw, b.bh]; // no line found: at least apply the drift correction
      b.f.uncertain = true;
    }
    b.f.angle = tilt;
  }
  // Checkboxes: a wrong box means a wrong answer (Yes vs No), so find the real printed squares instead of trusting the
  // model. Anything we cannot pin down is marked `uncertain`: it is drawn dashed and the agent describes it in words.
  const small = info2.filter(b => !b.wide);
  if (small.length) {
    const targets = small.map(b => ({ cx: (b.x0 + b.x1) / 2, cy: corrected({ by: b.by }) - (b.bh * h) / 2, s: Math.max(b.x1 - b.x0, b.bh * h) }));
    const found = await locateSquares(data, w, h, tilt, targets);
    small.forEach((b, i) => {
      const sq = found[i];
      if (sq) {
        const pad = 0.12 * sq.s;
        b.f.bbox = [(sq.cx - sq.s / 2 - pad) / w, (sq.cy - sq.s / 2 - pad) / h, (sq.s + 2 * pad) / w, (sq.s + 2 * pad) / h];
        b.f.uncertain = false;
      } else {
        const [x, y, bw, bh] = b.f.bbox;
        b.f.bbox = [x, corrected(b) / h - bh, bw, bh];
        b.f.uncertain = true;
      }
      b.f.angle = tilt;
    });
  }
  return { matched, total: order.length, tilt, boxes: small.length, boxesFound: small.filter(b => b.f.uncertain === false).length };
}

/**
 * Find printed checkbox squares near where we expect them. The page is deskewed first (so a tilted square is square),
 * then every candidate square size is tested by looking for the four edges. Candidates are matched one-to-one to the
 * targets, so two neighbouring boxes (Yes / No) can never claim the same square.
 * @param targets [{ cx, cy, s }] expected centre and size in pixels of the 800-wide analysis image
 * @returns array parallel to targets: { cx, cy, s } in the same pixel space, or null when no square was found
 */
async function locateSquares(gray0, w0, h0, tiltDeg, targets) {
  let gray = gray0, w = w0, h = h0;
  const th = (tiltDeg * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
  let toDeskew = p => p, fromDeskew = p => p;
  if (Math.abs(tiltDeg) >= 0.5) {
    // rotate the grayscale by -tilt (sharp rotates clockwise; the page is tilted clockwise by tilt)
    const rot = await sharp(Buffer.from(gray0), { raw: { width: w0, height: h0, channels: 1 } }).rotate(-tiltDeg, { background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    gray = rot.data; w = rot.info.width; h = rot.info.height;
    toDeskew = p => { const x = p.cx - w0 / 2, y = p.cy - h0 / 2; return { ...p, cx: x * cs + y * sn + w / 2, cy: -x * sn + y * cs + h / 2 }; };
    fromDeskew = p => { const x = p.cx - w / 2, y = p.cy - h / 2; return { ...p, cx: x * cs - y * sn + w0 / 2, cy: x * sn + y * cs + h0 / 2 }; };
  }
  // ink = darker than the pixels 4 px away horizontally or vertically (catches both horizontal and vertical edges)
  const ink = new Uint8Array(w * h);
  for (let r = 4; r < h - 4; r++) for (let c = 4; c < w - 4; c++) {
    const v = gray[r * w + c];
    const bh = (gray[r * w + c - 4] + gray[r * w + c + 4]) / 2, bv = (gray[(r - 4) * w + c] + gray[(r + 4) * w + c]) / 2;
    if (v < Math.max(bh, bv) - 28) ink[r * w + c] = 1;
  }
  const hrun = new Int16Array(w * h), vrun = new Int16Array(w * h);
  for (let r = 0; r < h; r++) for (let c = w - 1; c >= 0; c--) hrun[r * w + c] = ink[r * w + c] ? 1 + (c + 1 < w ? hrun[r * w + c + 1] : 0) : 0;
  for (let c = 0; c < w; c++) for (let r = h - 1; r >= 0; r--) vrun[r * w + c] = ink[r * w + c] ? 1 + (r + 1 < h ? vrun[(r + 1) * w + c] : 0) : 0;
  const H = (r, c) => Math.max(hrun[r * w + c], hrun[(r + 1) * w + c], hrun[(r - 1) * w + c]);
  const V = (r, c) => Math.max(vrun[r * w + c], vrun[r * w + c + 1], vrun[r * w + c - 1]);
  const tg = targets.map(toDeskew);
  const out = tg.map(() => null);
  // candidate squares in a window around every target
  const cands = [];
  const seen = new Set();
  for (const t of tg) {
    const sMin = Math.max(8, Math.round(t.s * 0.6)), sMax = Math.min(40, Math.round(t.s * 1.6) + 6);
    const wx = Math.round(0.08 * w0), wy = Math.round(0.1 * h0);
    for (let r = Math.max(2, Math.round(t.cy - wy)); r < Math.min(h - 3, Math.round(t.cy + wy)); r++) {
      for (let c = Math.max(2, Math.round(t.cx - wx)); c < Math.min(w - 3, Math.round(t.cx + wx)); c++) {
        if (!ink[r * w + c] && !ink[(r + 1) * w + c] && !ink[r * w + c + 1]) continue; // a corner pixel must be ink
        for (let s = sMin; s <= sMax; s++) {
          if (r + s >= h - 2 || c + s >= w - 2) break;
          if (H(r, c) < s - 4 || V(r, c) < s - 4 || H(r + s, c) < s - 4 || V(r, c + s) < s - 4) continue;
          let inside = 0; // a filled blob is not a box; a ticked box has some ink inside
          for (let y = r + 3; y < r + s - 2; y += 2) for (let x = c + 3; x < c + s - 2; x += 2) inside += ink[y * w + x];
          const area = Math.max(1, ((s - 5) / 2) * ((s - 5) / 2));
          if (inside / area > 0.6) continue;
          const key = r + ',' + c + ',' + s;
          if (seen.has(key)) continue;
          seen.add(key);
          // edge strength: how fully all four edges are inked
          let ring = 0, n = 0;
          for (let k = 0; k <= s; k++) { ring += ink[r * w + c + k] + ink[(r + s) * w + c + k] + ink[(r + k) * w + c] + ink[(r + k) * w + c + s]; n += 4; }
          cands.push({ cx: c + s / 2, cy: r + s / 2, s, q: ring / n });
        }
      }
    }
  }
  // keep the best candidate per cluster (one printed square gives many near-identical candidates)
  cands.sort((p, q) => q.q - p.q || q.s - p.s);
  const squares = [];
  for (const c of cands) if (c.q >= 0.62 && !squares.some(s => Math.hypot(s.cx - c.cx, s.cy - c.cy) < Math.max(s.s, c.s) * 0.7)) squares.push(c);
  // Safety first. Neighbouring boxes (Yes / No) form a group. We only trust the match when the number of squares found near the
  // group equals the number of boxes in it, and then give them out in reading order. Any other count is ambiguous: a lone
  // square could belong to either box, so the whole group stays `null` (uncertain) instead of guessing the wrong answer.
  const reach = 0.08 * h0;
  const near = (t, s) => Math.hypot(s.cx - t.cx, s.cy - t.cy) <= reach;
  const groupOf = new Array(tg.length).fill(-1);
  let groups = 0;
  tg.forEach((t, i) => {
    if (groupOf[i] >= 0) return;
    const stack = [i]; groupOf[i] = groups;
    while (stack.length) { const k = stack.pop(); tg.forEach((u, j) => { if (groupOf[j] < 0 && Math.hypot(u.cx - tg[k].cx, u.cy - tg[k].cy) < Math.max(4 * t.s, 0.09 * h0)) { groupOf[j] = groups; stack.push(j); } }); }
    groups++;
  });
  const reading = (a, b) => (Math.abs(a.cy - b.cy) > 0.6 * Math.min(a.s, b.s) ? a.cy - b.cy : a.cx - b.cx);
  for (let g = 0; g < groups; g++) {
    const idx = tg.map((_, i) => i).filter(i => groupOf[i] === g);
    const sq = squares.filter(s => idx.some(i => near(tg[i], s)));
    if (sq.length !== idx.length) continue; // ambiguous: leave the whole group uncertain
    const ts = [...idx].sort((p, q) => reading(tg[p], tg[q]));
    const ss = [...sq].sort(reading);
    ts.forEach((ti, k) => { out[ti] = fromDeskew({ cx: ss[k].cx, cy: ss[k].cy, s: ss[k].s }); });
  }
  return out;
}

/**
 * Answer one question about the document as it is in front of the camera RIGHT NOW (after a scroll, a page turn, a move).
 * Plain text, in English: the voice model translates it for the caller.
 * @param {Buffer} image PNG/JPEG of the current view
 * @param {string} question the caller's question
 * @param {string} memory short notes about parts of the same document seen earlier ('' if none)
 * @returns {Promise<string>}
 */
export async function answerAboutPage(image, question, memory = '') {
  const jpeg = await sharp(image).resize({ width: READ_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const system = `You answer a caller's question about a document (paper or on a screen) shown in ONE camera photo.
Answer from what is visible in the photo, reading ALL the text including tiny footnotes. Notes about earlier parts of the same document may be given: use them only if the photo does not show the answer, and say the answer comes from the earlier part.
If the answer is not in the photo, say which part of the document IS visible and tell the caller exactly what to show (for example "scroll down", "show the top", "move closer to the footer").
Be concise: at most three short sentences, plain words, in English. Never invent details.`;
  const text = `Question: ${question}\n\nNotes about earlier parts of the same document (may be empty):\n${memory || '(none)'}`;
  if (visionProvider() === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    genai ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const res = await gen({
      model: process.env.VISION_MODEL || 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text }] }],
      config: { systemInstruction: system, temperature: 0, httpOptions: { timeout: 15000 } },
    });
    return (res.text ?? '').trim();
  }
  client ??= new Anthropic();
  const res = await client.messages.create({
    model: MODEL, max_tokens: 400, system,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }, { type: 'text', text }] }],
  });
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
