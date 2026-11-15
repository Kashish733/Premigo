// Draws the "Notice" overlay on top of a camera frame: a box on the field the caller is on,
// its label in the caller's language, and red boxes on mistakes. Output is raw RGBA, ready for
// VideoSource.captureFrame (see agent.mjs / face.mjs for how frames are published).
import sharp from 'sharp';

export const WIDTH = 640;
export const HEIGHT = 360;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { current: '#22c55e', issue: '#ef4444', other: '#38bdf8' };

/**
 * DocState field: { id, label_en, label_es, bbox: [x, y, w, h] (each 0..1 of the image), filled, value }
 * @param {Buffer} image   PNG/JPEG bytes of the camera frame
 * @param {{ fields?: object[] }} state
 * @param {{ currentField?: string, issues?: Record<string,string>, lang?: 'es'|'en', banner?: string, showAll?: boolean }} opts
 * @returns {Promise<Buffer>} WIDTH x HEIGHT x 4 RGBA bytes
 */
export async function annotateFrame(image, state, opts = {}) {
  const { currentField, issues = {}, lang = 'es', banner, showAll = false } = opts;
  const parts = [];
  for (const f of state?.fields ?? []) {
    const isCurrent = f.id === currentField, issue = issues[f.id];
    if (!isCurrent && !issue && !showAll) continue;
    const [bx, by, bw, bh] = f.bbox;
    const x = bx * WIDTH, y = by * HEIGHT, w = bw * WIDTH, h = bh * HEIGHT;
    const color = issue ? COLORS.issue : isCurrent ? COLORS.current : COLORS.other;
    const label = esc(issue ?? (lang === 'es' ? f.label_es : f.label_en) ?? f.label_en);
    const tw = Math.min(WIDTH - 8, 10 + label.length * 7.2);
    const lx = Math.max(4, Math.min(x, WIDTH - tw - 4));
    const ly = y > 26 ? y - 24 : y + h + 4; // above the box, or below if there is no room
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="3"/>`,
      `<rect x="${lx}" y="${ly}" width="${tw}" height="20" rx="4" fill="${color}"/>`,
      `<text x="${lx + 5}" y="${ly + 14.5}" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#fff">${label}</text>`,
    );
  }
  if (banner) {
    parts.push(
      `<rect x="0" y="${HEIGHT - 30}" width="${WIDTH}" height="30" fill="#0f172a" fill-opacity="0.82"/>`,
      `<text x="10" y="${HEIGHT - 10}" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#fff">${esc(banner)}</text>`,
    );
  }
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${parts.join('')}</svg>`);
  // `image` is encoded bytes, or { raw: Uint8Array, width, height } of RGBA pixels straight from a video frame.
  const input = image?.raw ? sharp(image.raw, { raw: { width: image.width, height: image.height, channels: 4 } }) : sharp(image);
  return input
    .resize(WIDTH, HEIGHT, { fit: 'contain', background: '#111827' })
    .composite([{ input: overlay }])
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** Same as annotateFrame but returns a PNG, for saving to disk or sending over iMessage. */
export async function annotateToPng(image, state, opts) {
  const rgba = await annotateFrame(image, state, opts);
  return sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
}
