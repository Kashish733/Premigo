// Draws fake handwriting on forms/permiso.png to test mistake detection offline.
// Run: node gen-filled.mjs -> forms/permiso-ok.png, permiso-wrongplace.png, permiso-skipped.png
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const gt = JSON.parse(readFileSync('forms/permiso.json', 'utf8'));
const W = 960, H = 540;
const at = id => { const f = gt.fields.find(x => x.id === id); return { x: f.bbox[0] * W, y: f.bbox[1] * H, w: f.bbox[2] * W, h: f.bbox[3] * H }; };
const ink = (id, text, size = 22) => { const b = at(id); return `<text x="${b.x + 6}" y="${b.y + b.h - 3}" font-family="Snell Roundhand, Bradley Hand, Brush Script MT, cursive" font-size="${size}" fill="#1d3a8a">${text}</text>`; };
const tick = id => { const b = at(id); return `<path d="M${b.x + 4} ${b.y + 11} L${b.x + 9} ${b.y + 17} L${b.x + 18} ${b.y + 3}" stroke="#1d3a8a" stroke-width="3" fill="none"/>`; };

const base = {
  student_name: ink('student_name', 'Sofia Ramirez'), grade: ink('grade', '3rd'),
  guardian: ink('guardian', 'Maria Ramirez'), phone: ink('phone', '817-555-0142'),
  allergies: ink('allergies', 'none'), authorize: tick('authorize'),
};
const variants = {
  ok: { ...base, signature: ink('signature', 'Maria Ramirez', 26), date: ink('date', '11/14/2026') },
  // signature written on the DATE line, signature line left empty
  wrongplace: { ...base, date: ink('date', 'Maria Ramirez', 26) },
  // guardian name skipped but later fields (phone, signature) are filled
  skipped: { ...base, guardian: '', signature: ink('signature', 'Maria Ramirez', 26), date: ink('date', '11/14/2026') },
};
for (const [name, parts] of Object.entries(variants)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${Object.values(parts).join('')}</svg>`;
  writeFileSync(`forms/permiso-${name}.png`, await sharp('forms/permiso.png').composite([{ input: Buffer.from(svg) }]).png().toBuffer());
  console.log('wrote', `forms/permiso-${name}.png`);
}
