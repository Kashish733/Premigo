// Draws the "Notice" overlay on top of a camera frame: a box on the field the caller is on,
// its label in the caller's language, and red boxes on mistakes. Output is raw RGBA, ready for
// VideoSource.captureFrame (see agent.mjs / face.mjs for how frames are published).
import sharp from 'sharp';

// Portrait by default: an iPhone held upright on FaceTime shows a portrait video full-screen, but a landscape one
// only as a band across the middle. Override with OUT_W / OUT_H (e.g. 640 x 360) if you hold the phone sideways.
// 1080x1920: the phone shows our video at roughly its native pixel size, so a small video looks small on screen.
export const WIDTH = Number(process.env.OUT_W) || 1280;
export const HEIGHT = Number(process.env.OUT_H) || 720;
const K = WIDTH / 540; // overlay sizes below were designed for a 540-wide picture

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
  const { currentField, issues = {}, lang = 'es', banner, alert, chip, badge, showAll = false } = opts;
  // `image` is encoded bytes, or { raw: Uint8Array, width, height } of RGBA pixels straight from a video frame.
  const input = image?.raw ? sharp(image.raw, { raw: { width: image.width, height: image.height, channels: 4 } }) : sharp(image);
  const iw = image?.raw ? image.width : (await sharp(image).metadata()).width;
  const ih = image?.raw ? image.height : (await sharp(image).metadata()).height;
  // The picture is letterboxed into the canvas ("contain"), so field boxes (fractions of the PICTURE) must be mapped
  // into the area the picture really occupies, not the whole canvas. Matters for portrait, 4:3 and tilted frames.
  const scale = Math.min(WIDTH / iw, HEIGHT / ih);
  const dw = iw * scale, dh = ih * scale, ox = (WIDTH - dw) / 2, oy = (HEIGHT - dh) / 2;
  const parts = [];
  for (const f of state?.fields ?? []) {
    const isCurrent = f.id === currentField, issue = issues[f.id];
    if (!isCurrent && !issue && !showAll) continue;
    const [bx, by, bw, bh] = f.bbox;
    const padY = Math.max(0, 0.04 * dh - bh * dh) / 2 + 2 * K; // thin writing lines get a taller highlight
    const x = ox + bx * dw - 2 * K, y = oy + by * dh - padY, w = bw * dw + 4 * K, h = bh * dh + 2 * padY;
    const color = issue ? COLORS.issue : isCurrent ? COLORS.current : COLORS.other;
    const label = esc((issue ?? (lang === 'es' ? f.label_es : f.label_en) ?? f.label_en) + (f.uncertain && !issue ? '  (aprox. / approx.)' : ''));
    const tw = Math.min(WIDTH - 8 * K, (10 + label.length * 7.2) * K);
    const lx = Math.max(4 * K, Math.min(x, WIDTH - tw - 4 * K));
    const ly = y > 26 * K ? y - 24 * K : y + h + 4 * K; // above the box, or below if there is no room
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${3 * K}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="${3 * K}" ${f.uncertain ? `stroke-dasharray="${8 * K} ${6 * K}"` : ''} transform="rotate(${f.angle || 0} ${x + w / 2} ${y + h / 2})"/>`,
      `<rect x="${lx}" y="${ly}" width="${tw}" height="${20 * K}" rx="${4 * K}" fill="${color}"/>`,
      `<text x="${lx + 5 * K}" y="${ly + 14.5 * K}" font-family="Helvetica, Arial, sans-serif" font-size="${12 * K}" font-weight="700" fill="#fff">${label}</text>`,
    );
  }
  if (alert) { // persistent red strip, e.g. a possible scam
    parts.push(
      `<rect x="0" y="0" width="${WIDTH}" height="${28 * K}" fill="#b91c1c"/>`,
      `<text x="${WIDTH / 2}" y="${19 * K}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${15 * K}" font-weight="700" fill="#fff">! ${esc(alert)} !</text>`,
    );
  }
  if (chip) { // small label for the current mode, top right (below the alert strip if there is one)
    const cw = (14 + chip.length * 7.6) * K, cy0 = (alert ? 36 : 8) * K;
    parts.push(
      `<rect x="${WIDTH - cw - 10 * K}" y="${cy0}" width="${cw}" height="${24 * K}" rx="${12 * K}" fill="#0f172a" fill-opacity="0.78" stroke="#8de0c4" stroke-width="${1.5 * K}"/>`,
      `<text x="${WIDTH - cw / 2 - 10 * K}" y="${cy0 + 16.5 * K}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${13 * K}" font-weight="700" fill="#fff">${esc(chip)}</text>`,
    );
  }
  if (banner) {
    parts.push(
      `<rect x="0" y="${HEIGHT - 30 * K}" width="${WIDTH}" height="${30 * K}" fill="#0f172a" fill-opacity="0.82"/>`,
      `<text x="${10 * K}" y="${HEIGHT - 10 * K}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.max(9 * K, Math.min(14 * K, (WIDTH - 20 * K) / (banner.length * 0.56)))}" fill="#fff">${esc(banner)}</text>`,
    );
  }
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${parts.join('')}</svg>`);
  return input
    .resize(WIDTH, HEIGHT, { fit: 'contain', background: '#111827' })
    .composite([{ input: overlay }, ...(badge ? [badge] : [])]) // badge = { input: PNG, left, top }: the corner character
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** Same as annotateFrame but returns a PNG, for saving to disk or sending over iMessage. */
export async function annotateToPng(image, state, opts) {
  const rgba = await annotateFrame(image, state, opts);
  return sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
}
