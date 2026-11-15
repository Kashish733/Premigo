// Frame quality gate + "read this page" call to Claude. Output is a DocState the voice agent can
// talk about and the annotator can draw from.
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

const MODEL = process.env.VISION_MODEL || 'claude-sonnet-5-5';

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

/** Which provider reads pages: Claude if ANTHROPIC_API_KEY is set, otherwise Gemini (GOOGLE_API_KEY). */
export function visionProvider() {
  return process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.GOOGLE_API_KEY ? 'gemini' : null;
}

let client, genai;
/** @param {Buffer} image PNG/JPEG bytes */
export async function readDocument(image) {
  const jpeg = await sharp(image).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
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
  const res = await genai.models.generateContent({
    model: process.env.VISION_MODEL || 'gemini-3.1-flash-lite',
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: 'Read this page.' }] }],
    config: {
      systemInstruction: SYSTEM, responseMimeType: 'application/json', temperature: 0.1,
      httpOptions: { timeout: 25000 }, // a live call cannot wait long
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
  const jpeg = await sharp(image).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const list = doc.fields.map(f => `- ${f.id}: ${f.label_en} (${f.hint_en ?? 'fill in'})`).join('\n');
  const text = `Fields, in page order:\n${list}\n\nCheck the handwriting on this page.`;
  let raw;
  if (visionProvider() === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    genai ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const res = await genai.models.generateContent({
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
