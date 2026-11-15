// Test pattern for finding out how FaceTime fits our video on the phone. Run the agent with NOTICE_CALIBRATE=1,
// call it, and screenshot the phone: the edges, labels and shape outlines show what is cropped, scaled or padded.
import sharp from 'sharp';
import { WIDTH as W, HEIGHT as H } from './annotate.mjs';

export async function makeCalibrationFrame() {
  const k = W / 540;
  const t = (x, y, s, size, extra = '') => `<text x="${x}" y="${y}" font-family="Helvetica, Arial" font-size="${size * k}" font-weight="700" ${extra.includes('fill=') ? '' : 'fill="#fff"'} ${extra}>${s}</text>`;
  // shapes inscribed in the canvas: label them so a screenshot shows which one the phone treats as "the screen"
  const shapes = [['16:9', 16 / 9, '#facc15'], ['4:3', 4 / 3, '#22d3ee'], ['1:1', 1, '#a3e635'], ['3:4', 3 / 4, '#fb923c']];
  const outlines = shapes.map(([name, ar, color], i) => {
    const w = ar >= W / H ? W : H * ar, h = ar >= W / H ? W / ar : H;
    const x = (W - w) / 2, y = (H - h) / 2;
    return `<rect x="${x + 6 * k}" y="${y + 6 * k}" width="${w - 12 * k}" height="${h - 12 * k}" fill="none" stroke="${color}" stroke-width="${3 * k}" stroke-dasharray="${14 * k} ${10 * k}"/>` +
      t(x + 16 * k, y + (30 + i * 0) * k + (i * 26 * k), `${name} box`, 20, `fill="${color}"`);
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#1e293b"/>
    <line x1="0" y1="0" x2="${W}" y2="${H}" stroke="#475569" stroke-width="${2 * k}"/><line x1="${W}" y1="0" x2="0" y2="${H}" stroke="#475569" stroke-width="${2 * k}"/>
    ${outlines}
    <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ec4899" stroke-width="${12 * k}"/>
    <rect x="0" y="0" width="${W}" height="${40 * k}" fill="#ef4444"/>${t(W / 2, 28 * k, 'TOP', 24, 'text-anchor="middle"')}
    <rect x="0" y="${H - 40 * k}" width="${W}" height="${40 * k}" fill="#3b82f6"/>${t(W / 2, H - 12 * k, 'BOTTOM', 24, 'text-anchor="middle"')}
    <rect x="0" y="${H / 2 - 100 * k}" width="${40 * k}" height="${200 * k}" fill="#22c55e"/>${t(48 * k, H / 2 + 8 * k, 'LEFT', 22)}
    <rect x="${W - 40 * k}" y="${H / 2 - 100 * k}" width="${40 * k}" height="${200 * k}" fill="#a855f7"/>${t(W - 48 * k, H / 2 + 8 * k, 'RIGHT', 22, 'text-anchor="end"')}
    ${t(W / 2, H / 2 - 40 * k, `${W} x ${H}`, 40, 'text-anchor="middle"')}
    ${t(W / 2, H / 2 + 20 * k, 'calibration frame', 24, 'text-anchor="middle"')}
  </svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}
