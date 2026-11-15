// "Notice", the friendly animated face. Drawn as SVG each frame (blinking, bobbing, mouth moving while it talks),
// so there are no assets and no extra accounts. Two views:
//   renderCharacterFrame: full-screen welcome screen with the three choices on it
//   renderBadge:          a small round version that sits in a corner of the camera view
import sharp from 'sharp';

const INK = '#0f2a35', SKIN = '#8de0c4', SKIN_D = '#5cc4a4', CHEEK = '#f9a8a8';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** SVG pieces for the head. state: speaking | thinking | listening (anything else); mood: happy | warn. */
function face({ cx, cy, r, tick, state, mood, mouthOpen }) {
  const speaking = state === 'speaking', thinking = state === 'thinking', warn = mood === 'warn';
  const y = cy + Math.sin(tick * 0.22) * r * (speaking ? 0.025 : 0.012); // gentle bob
  const blink = tick % 48 < 3;
  const lookX = thinking ? 0.07 : speaking ? Math.sin(tick * 0.11) * 0.025 : Math.sin(tick * 0.05) * 0.02;
  const lookY = thinking ? -0.07 : 0;
  // mouth opening 0..1: follows the real audio loudness when we have it, otherwise a made-up flapping
  const amp = speaking ? (mouthOpen ?? Math.abs(Math.sin(tick * 0.9)) * (0.55 + 0.45 * Math.sin(tick * 0.31 + 1))) : 0;

  const eye = sx => {
    const ex = cx + sx * r, ey = y - 0.1 * r;
    if (blink) return `<path d="M ${ex - 0.17 * r} ${ey} Q ${ex} ${ey + 0.06 * r} ${ex + 0.17 * r} ${ey}" stroke="${INK}" stroke-width="${0.04 * r}" fill="none" stroke-linecap="round"/>`;
    const px = ex + lookX * r, py = ey + lookY * r;
    return `<ellipse cx="${ex}" cy="${ey}" rx="${0.19 * r}" ry="${0.19 * r}" fill="#fff"/>` +
      `<circle cx="${px}" cy="${py}" r="${0.095 * r}" fill="${INK}"/><circle cx="${px + 0.03 * r}" cy="${py - 0.035 * r}" r="${0.03 * r}" fill="#fff"/>`;
  };
  const brow = side => { // side -1 = left eye, +1 = right eye
    const bx = cx + side * 0.38 * r, by = y - 0.37 * r, w = 0.17 * r;
    const stroke = `stroke="${INK}" stroke-width="${0.045 * r}" fill="none" stroke-linecap="round"`;
    if (warn) { // worried: inner ends raised
      const l = side < 0 ? 0.03 : -0.05, rr = side < 0 ? -0.05 : 0.03;
      return `<path d="M ${bx - w} ${by + l * r} L ${bx + w} ${by + rr * r}" ${stroke}/>`;
    }
    const lift = thinking && side > 0 ? -0.05 * r : 0; // one eyebrow up while thinking
    return `<path d="M ${bx - w} ${by + lift} Q ${bx} ${by + lift - 0.07 * r} ${bx + w} ${by + lift}" ${stroke}/>`;
  };
  let mouth;
  const my = y + 0.34 * r;
  if (speaking) {
    mouth = `<ellipse cx="${cx}" cy="${my + 0.04 * r}" rx="${0.2 * r}" ry="${(0.03 + 0.13 * amp) * r}" fill="${INK}"/>` +
      (amp > 0.35 ? `<ellipse cx="${cx}" cy="${my + (0.04 + 0.1 * amp) * r}" rx="${0.11 * r}" ry="${0.04 * r * amp}" fill="#f07a7a"/>` : '');
  } else if (thinking) {
    mouth = `<ellipse cx="${cx + 0.1 * r}" cy="${my + 0.07 * r}" rx="${0.05 * r}" ry="${0.04 * r}" fill="${INK}"/>`;
  } else if (warn) {
    mouth = `<path d="M ${cx - 0.18 * r} ${my + 0.14 * r} Q ${cx} ${my + 0.03 * r} ${cx + 0.18 * r} ${my + 0.14 * r}" stroke="${INK}" stroke-width="${0.04 * r}" fill="none" stroke-linecap="round"/>`;
  } else {
    mouth = `<path d="M ${cx - 0.21 * r} ${my} Q ${cx} ${my + 0.2 * r} ${cx + 0.21 * r} ${my}" stroke="${INK}" stroke-width="${0.04 * r}" fill="none" stroke-linecap="round"/>`;
  }
  const bulb = warn ? '#ef4444' : speaking ? '#fde047' : '#38bdf8';
  const glow = 0.55 + 0.45 * Math.sin(tick * 0.3);
  return [
    `<line x1="${cx}" y1="${y - r}" x2="${cx + Math.sin(tick * 0.2) * 0.04 * r}" y2="${y - 1.24 * r}" stroke="${SKIN_D}" stroke-width="${0.05 * r}" stroke-linecap="round"/>`,
    `<circle cx="${cx + Math.sin(tick * 0.2) * 0.04 * r}" cy="${y - 1.27 * r}" r="${0.085 * r}" fill="${bulb}" opacity="${glow.toFixed(2)}"/>`,
    `<circle cx="${cx}" cy="${y}" r="${r}" fill="${SKIN}" stroke="${SKIN_D}" stroke-width="${0.035 * r}"/>`,
    `<ellipse cx="${cx - 0.32 * r}" cy="${y - 0.58 * r}" rx="${0.26 * r}" ry="${0.11 * r}" fill="#fff" opacity="0.2"/>`,
    `<ellipse cx="${cx - 0.55 * r}" cy="${y + 0.22 * r}" rx="${0.14 * r}" ry="${0.09 * r}" fill="${CHEEK}" opacity="0.5"/>`,
    `<ellipse cx="${cx + 0.55 * r}" cy="${y + 0.22 * r}" rx="${0.14 * r}" ry="${0.09 * r}" fill="${CHEEK}" opacity="0.5"/>`,
    eye(-0.38), eye(0.38), brow(-1), brow(1), mouth,
  ].join('');
}

const CAPTION = { listening: 'Te escucho · I\'m listening', thinking: 'Un momento… · One moment…' };
const CHOICES = [
  ['1', 'Fill it out', 'Llenarlo'],
  ['2', 'Understand it', 'Entenderlo'],
  ['3', 'Is it a scam?', '¿Es una estafa?'],
];

/**
 * Full-screen character with an optional menu of the three things it can do.
 * @returns {Promise<Buffer>} width x height x 4 RGBA bytes
 */
export async function renderCharacterFrame({ width: W, height: H, tick, state = 'listening', mood = 'happy', menu = true, caption, mouth }) {
  // With a menu the head is smaller and sits high (room for the question and the options); without one it is big and centred.
  const r = (menu ? 0.17 : 0.22) * H, cx = W / 2, cy = (menu ? 0.265 : 0.4) * H;
  const parts = [
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#12403f"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
  ];
  for (let i = 0; i < 4; i++) { // slow floating bubbles, so the screen never looks frozen
    const bx = W * (0.12 + 0.25 * i) + Math.sin(tick * 0.03 + i * 2) * 20, by = H * (0.2 + 0.18 * ((i * 3) % 4)) + Math.cos(tick * 0.025 + i) * 14;
    parts.push(`<circle cx="${bx}" cy="${by}" r="${H * (0.03 + 0.012 * i)}" fill="#8de0c4" opacity="0.07"/>`);
  }
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 1.18}" fill="#8de0c4" opacity="0.1"/>`);
  parts.push(face({ cx, cy, r, tick, state, mood, mouthOpen: mouth }));
  parts.push(`<text x="${cx}" y="${cy + r * 1.42}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${0.055 * H}" font-weight="700" fill="#e2f4ef">Notice</text>`);
  const cap = caption ?? CAPTION[state];
  if (cap) parts.push(`<text x="${cx}" y="${cy + r * 1.42 + 0.055 * H}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${0.034 * H}" fill="#9fd8c9">${esc(cap)}</text>`);
  if (menu) {
    parts.push(`<text x="${cx}" y="${0.655 * H}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${0.042 * H}" font-weight="700" fill="#fff">${esc('¿En qué te ayudo con tu documento? · How can I help?')}</text>`);
    const pw = Math.min(0.8 * W, 1.15 * H), ph = 0.072 * H, gap = 0.02 * H, x0 = (W - pw) / 2;
    CHOICES.forEach(([n, en, es], i) => {
      const y0 = 0.69 * H + i * (ph + gap);
      parts.push(
        `<rect x="${x0}" y="${y0}" width="${pw}" height="${ph}" rx="${ph / 2}" fill="#ffffff" fill-opacity="0.12" stroke="#8de0c4" stroke-opacity="0.6" stroke-width="2"/>`,
        `<circle cx="${x0 + ph / 2}" cy="${y0 + ph / 2}" r="${ph * 0.33}" fill="#8de0c4"/>`,
        `<text x="${x0 + ph / 2}" y="${y0 + ph / 2 + 0.013 * H}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${0.04 * H}" font-weight="700" fill="${INK}">${n}</text>`,
        `<text x="${x0 + ph * 1.05}" y="${y0 + ph / 2 + 0.013 * H}" font-family="Helvetica, Arial, sans-serif" font-size="${0.037 * H}" font-weight="700" fill="#fff">${esc(en)}<tspan fill="#9fd8c9" font-weight="400" dx="${0.012 * H}">· ${esc(es)}</tspan></text>`,
      );
    });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}

/** Small round version of the character for a corner of the camera view. @returns {Promise<Buffer>} PNG with transparency */
export async function renderBadge({ size: s, tick, state = 'listening', mood = 'happy', mouth }) {
  const r = 0.36 * s, cx = s / 2, cy = 0.58 * s;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r * 1.12}" fill="#0f172a" opacity="0.55"/>` + face({ cx, cy, r, tick, state, mood, mouthOpen: mouth }) + `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
